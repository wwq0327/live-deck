/**
 * Minimal DOM stand-in for renderer tests. Implements only what the presenter
 * touches, so tests can assert element identity without a browser.
 */

class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(...names) {
    for (const n of names) this.set.add(n);
  }
  remove(...names) {
    for (const n of names) this.set.delete(n);
  }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }
  contains(name) {
    return this.set.has(name);
  }
  get value() {
    return [...this.set].join(' ');
  }
}

export class FakeElement {
  constructor(doc, tagName, namespaceURI = null) {
    this.ownerDocument = doc;
    this.tagName = String(tagName).toUpperCase();
    this.namespaceURI = namespaceURI;
    this.children = [];
    this.parentNode = null;
    this.attrs = Object.create(null);
    this.dataset = {};
    this.style = {};
    this.classList = new ClassList();
    this._text = '';
    Object.defineProperty(this, 'textContent', {
      get: () => this._text,
      set: (value) => {
        this._text = value == null ? '' : String(value);
        this.children = [];
      },
    });
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    child.parentNode = null;
    return child;
  }
  get firstChild() {
    return this.children[0] || null;
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name.startsWith('data-')) {
      const camel = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[camel] = String(value);
    }
  }
  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }
  removeAttribute(name) {
    delete this.attrs[name];
  }
  querySelector(selector) {
    const match = (el) => {
      if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
      if (selector.startsWith('#')) return el.attrs.id === selector.slice(1);
      return el.tagName === selector.toUpperCase();
    };
    const walk = (el) => {
      for (const child of el.children) {
        if (match(child)) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }
  set innerHTML(_value) {
    throw new Error('innerHTML must not be used');
  }
}

export function makeDoc() {
  const doc = {
    createElement: (tag) => new FakeElement(doc, tag),
    createElementNS: (ns, tag) => new FakeElement(doc, tag, ns),
    defaultView: null,
  };
  return doc;
}

export function makeContainer(doc, { width = 1200, height = 680 } = {}) {
  const el = doc.createElement('div');
  el.clientWidth = width;
  el.clientHeight = height;
  return el;
}
