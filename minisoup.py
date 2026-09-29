"""표준 라이브러리만으로 쓰는 아주 작은 HTML 트리 파서.

bs4를 설치하지 않아도 되게, 커뮤니티 목록을 읽는 데 필요한 만큼만 구현했다.
select()는 'tag.class#id[attr]'를 공백(자손)으로 이은 선택자만 지원한다.
"""
import re
from html.parser import HTMLParser

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
SKIP = {"script", "style", "noscript", "template"}


class Node:
    __slots__ = ("tag", "attrs", "children", "parent")

    def __init__(self, tag, attrs=None, parent=None):
        self.tag = tag
        self.attrs = attrs or {}
        self.children = []
        self.parent = parent

    def get(self, key, default=""):
        v = self.attrs.get(key)
        return default if v is None else v

    @property
    def classes(self):
        return self.get("class").split()

    def text(self, sep=" "):
        out = []
        self._text(out)
        return re.sub(r"\s+", " ", sep.join(out)).strip()

    def _text(self, out):
        for c in self.children:
            if isinstance(c, str):
                out.append(c)
            elif c.tag not in SKIP:
                c._text(out)

    def iter(self):
        for c in self.children:
            if not isinstance(c, str):
                yield c
                yield from c.iter()

    def _match(self, tag, cls, id_, attrs):
        if tag and self.tag != tag:
            return False
        if id_ and self.get("id") != id_:
            return False
        if cls:
            mine = self.classes
            if any(c not in mine for c in cls):
                return False
        for k, v in attrs:
            if k not in self.attrs:
                return False
            if v is not None and self.attrs.get(k) != v:
                return False
        return True

    def select(self, selector):
        parts = [_parse_simple(p) for p in selector.split()]
        nodes = [self]
        for i, p in enumerate(parts):
            found, seen = [], set()
            for n in nodes:
                for d in n.iter():
                    if id(d) not in seen and d._match(*p):
                        seen.add(id(d))
                        found.append(d)
            nodes = found
        return nodes

    def select_one(self, selector):
        r = self.select(selector)
        return r[0] if r else None

    def find_all(self, tag=None, cls=None):
        return [d for d in self.iter() if d._match(tag, cls.split() if cls else [], None, [])]

    def find(self, tag=None, cls=None):
        for d in self.iter():
            if d._match(tag, cls.split() if cls else [], None, []):
                return d
        return None

    def closest(self, tag=None, cls=None):
        n = self.parent
        while n is not None:
            if n._match(tag, cls.split() if cls else [], None, []):
                return n
            n = n.parent
        return None


_SIMPLE = re.compile(r"([a-zA-Z0-9]+)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:=[\"']?([^\"'\]]*)[\"']?)?\]")


def _parse_simple(s):
    tag, cls, id_, attrs = None, [], None, []
    for m in _SIMPLE.finditer(s):
        if m.group(1):
            tag = m.group(1).lower()
        elif m.group(2):
            cls.append(m.group(2))
        elif m.group(3):
            id_ = m.group(3)
        else:
            attrs.append((m.group(4), m.group(5)))
    return tag, cls, id_, attrs


class _Builder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, {k: (v or "") for k, v in attrs}, self.stack[-1])
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        node = Node(tag, {k: (v or "") for k, v in attrs}, self.stack[-1])
        self.stack[-1].children.append(node)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def parse(html):
    b = _Builder()
    b.feed(html)
    b.close()
    return b.root
