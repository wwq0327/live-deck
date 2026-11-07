/**
 * Keyed DOM/SVG presenter. One element per scene/node/edge id; re-rendering
 * updates text, geometry and state in place. It never rewrites the container
 * with innerHTML and never interpolates model text as markup.
 */

import { layoutScene, relationWord } from './layouts.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CLAIM_FLAGS = {
  hypothesis: '设想',
  question: '提问',
  proposal: '提议',
  quotation: '引用',
};
let rendererSeq = 0;

function text(value) {
  return value == null ? '' : String(value);
}

export class SemanticRenderer {
  constructor(container, { doc = null, reducedMotion = null, animate = true, width = null, height = null } = {}) {
    if (!container) throw new Error('container is required');
    this.container = container;
    this.doc = doc || container.ownerDocument;
    this.window = this.doc.defaultView || (typeof window !== 'undefined' ? window : null);
    this.idPrefix = `sem${++rendererSeq}`;
    this.animate = animate;
    this.reducedMotion = reducedMotion == null ? this.#prefersReducedMotion() : Boolean(reducedMotion);
    this.width = width;
    this.height = height;
    this.nodeEls = new Map();
    this.edgeEls = new Map();
    this.groupEls = new Map();
    this.exiting = new Map();
    this.timers = new Set();
    this.sceneId = null;
    this.pinnedSceneId = null;
    this.lastLayout = null;
    this.lastState = null;

    this.root = this.doc.createElement('div');
    this.root.className = 'sem-stage';
    this.root.setAttribute('role', 'figure');
    this.root.dataset.reducedMotion = this.reducedMotion ? 'true' : 'false';

    this.titleEl = this.doc.createElement('div');
    this.titleEl.className = 'sem-scene-title';
    this.root.appendChild(this.titleEl);

    this.capacityEl = this.doc.createElement('div');
    this.capacityEl.className = 'sem-capacity';
    this.root.appendChild(this.capacityEl);

    this.groupLayer = this.doc.createElement('div');
    this.groupLayer.className = 'sem-groups';
    this.root.appendChild(this.groupLayer);

    this.svg = this.doc.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'sem-edges');
    this.svg.setAttribute('aria-hidden', 'true');
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.defs = this.doc.createElementNS(SVG_NS, 'defs');
    this.markerId = `${this.idPrefix}-arrow`;
    const marker = this.doc.createElementNS(SVG_NS, 'marker');
    marker.setAttribute('id', this.markerId);
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '7');
    marker.setAttribute('markerHeight', '7');
    marker.setAttribute('orient', 'auto-start-reverse');
    const arrow = this.doc.createElementNS(SVG_NS, 'path');
    arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    arrow.setAttribute('class', 'sem-arrowhead');
    marker.appendChild(arrow);
    this.defs.appendChild(marker);
    this.svg.appendChild(this.defs);
    this.edgeLayer = this.doc.createElementNS(SVG_NS, 'g');
    this.edgeLayer.setAttribute('class', 'sem-edge-layer');
    this.svg.appendChild(this.edgeLayer);
    this.root.appendChild(this.svg);

    this.nodeLayer = this.doc.createElement('div');
    this.nodeLayer.className = 'sem-nodes';
    this.root.appendChild(this.nodeLayer);

    this.emptyEl = this.doc.createElement('div');
    this.emptyEl.className = 'sem-empty';
    this.emptyEl.textContent = '等待第一段被理解的内容';
    this.root.appendChild(this.emptyEl);

    container.appendChild(this.root);
    this.unobserve = this.#observeResize();
    this.onWindowResize = () => {
      if (this.lastState) this.render(this.lastState, { animate: false, reason: 'window-resize' });
    };
    if (this.window && this.window.addEventListener) this.window.addEventListener('resize', this.onWindowResize);
  }

  #prefersReducedMotion() {
    try {
      const win = this.doc.defaultView || (typeof window !== 'undefined' ? window : null);
      return Boolean(win && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {
      return false;
    }
  }

  #observeResize() {
    const Robs = this.window && this.window.ResizeObserver;
    if (!Robs) return () => {};
    let frame = null;
    const observer = new Robs(() => {
      if (frame !== null) return;
      frame = this.#later(() => {
        frame = null;
        if (this.lastState) this.render(this.lastState, { animate: false, reason: 'resize' });
      }, 80);
    });
    observer.observe(this.container);
    return () => observer.disconnect();
  }

  #later(fn, ms) {
    const timer = this.window && this.window.setTimeout ? this.window.setTimeout(fn, ms) : setTimeout(fn, ms);
    this.timers.add(timer);
    return timer;
  }

  #cancelLater(timer) {
    if (timer == null) return;
    if (this.window && this.window.clearTimeout) this.window.clearTimeout(timer);
    else clearTimeout(timer);
    this.timers.delete(timer);
  }

  setReducedMotion(flag) {
    this.reducedMotion = Boolean(flag);
    this.root.dataset.reducedMotion = this.reducedMotion ? 'true' : 'false';
    if (this.lastState) this.render(this.lastState, { animate: false, reason: 'reduced-motion' });
  }

  #measure() {
    const width = this.width || this.container.clientWidth || 1200;
    const height = this.fixedHeight || this.container.clientHeight || 680;
    this.width = width;
    this.height = height;
    return { width, height };
  }

  #sceneOf(state) {
    if (!state || !state.scenes) return null;
    const id = this.pinnedSceneId && state.scenes[this.pinnedSceneId] ? this.pinnedSceneId : state.active_scene_id;
    if (id && state.scenes[id]) return state.scenes[id];
    const scenes = Object.values(state.scenes);
    return scenes.length ? scenes[scenes.length - 1] : null;
  }

  showScene(sceneId) {
    this.pinnedSceneId = sceneId;
    if (this.lastState) this.render(this.lastState, { animate: false, reason: 'scene' });
  }

  render(state, { animate = true, reason = 'update' } = {}) {
    const { width, height } = this.#measure();
    this.lastState = state;
    const scene = this.#sceneOf(state);
    const sceneId = scene ? scene.id : null;
    if (sceneId !== this.sceneId) {
      this.#clearAll();
      this.sceneId = sceneId;
    }
    this.root.dataset.reason = reason;
    this.root.dataset.sceneId = sceneId || '';
    this.root.dataset.family = scene ? scene.family : '';
    this.titleEl.textContent = scene ? text(scene.title) : '';
    this.titleEl.style.display = scene ? '' : 'none';

    if (!scene) {
      this.#clearAll();
      this.lastLayout = { nodes: [], edges: [], width, height };
      this.emptyEl.style.display = '';
      this.nodeLayer.style.display = 'none';
      this.svg.style.display = 'none';
      return this.snapshot();
    }

    const nodeById = state.nodes || {};
    const nodes = (scene.node_ids || [])
      .map((id) => nodeById[id])
      .filter((n) => n && n.state !== 'retracted');
    const edgeById = state.edges || {};
    const edges = (scene.edge_ids || [])
      .map((id) => edgeById[id])
      .filter((e) => e && e.state !== 'retracted');

    const layout = layoutScene({ scene, nodes, edges, width, height });
    this.lastLayout = layout;
    this.emptyEl.style.display = nodes.length ? 'none' : '';
    this.nodeLayer.style.display = nodes.length ? '' : 'none';
    this.svg.style.display = layout.edges.length ? '' : 'none';
    this.svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
    const families = layout.kind || scene.family || '';
    this.capacityEl.textContent = layout.capacity && layout.capacity.exceeded ? '内容超出单场景容量，将按观点续接（未丢弃）' : '';
    this.capacityEl.style.display = layout.capacity && layout.capacity.exceeded ? '' : 'none';

    const focus = new Set(scene.focus_ids || []);
    const targets = new Set(layout.targets || []);
    const doAnimate = Boolean(animate) && !this.reducedMotion;
    this.#reconcileGroups(layout.groups || [], doAnimate);
    this.#reconcileNodes(layout.nodes, nodeById, focus, targets, doAnimate);
    this.#reconcileEdges(layout.edges, edgeById, doAnimate);
    this.root.dataset.kind = families;
    return this.snapshot();
  }

  #reconcileGroups(groups, doAnimate) {
    const keep = new Set();
    for (const group of groups) {
      keep.add(group.id);
      let rec = this.groupEls.get(group.id);
      if (!rec) {
        const el = this.doc.createElement('div');
        el.className = 'sem-group';
        el.dataset.semId = group.id;
        const label = this.doc.createElement('span');
        label.className = 'sem-group-label';
        el.appendChild(label);
        this.groupLayer.appendChild(el);
        rec = { el, label };
        this.groupEls.set(group.id, rec);
        if (doAnimate) el.classList.add('sem-enter');
      }
      rec.el.style.transform = `translate3d(${Math.round(group.x)}px, ${Math.round(group.y)}px, 0)`;
      rec.el.style.width = `${Math.round(group.width)}px`;
      rec.el.style.height = `${Math.round(group.height)}px`;
      if (rec.label.textContent !== (group.label || '')) rec.label.textContent = group.label || '';
    }
    for (const [id, rec] of [...this.groupEls]) {
      if (keep.has(id)) continue;
      this.groupEls.delete(id);
      if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
    }
  }

  #reconcileNodes(placed, nodeById, focus, targets, doAnimate) {
    const keep = new Set();
    for (const spot of placed) {
      keep.add(spot.id);
      const model = nodeById[spot.id] || {};
      let rec = this.nodeEls.get(spot.id);
      if (!rec) {
        rec = this.#createNode(spot.id, doAnimate);
        this.nodeEls.set(spot.id, rec);
      }
      this.#updateNode(rec, spot, model, focus.has(spot.id), targets.has(spot.id), doAnimate);
    }
    for (const [id, rec] of [...this.nodeEls]) {
      if (keep.has(id)) continue;
      this.nodeEls.delete(id);
      this.#removeElement(id, rec, 'node', doAnimate);
    }
  }

  #createNode(id, doAnimate) {
    const el = this.doc.createElement('div');
    el.className = 'sem-node';
    el.dataset.semId = id;
    el.setAttribute('data-sem-id', id);
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    const kind = this.doc.createElement('span');
    kind.className = 'sem-node-kind';
    const label = this.doc.createElement('span');
    label.className = 'sem-node-label';
    const flag = this.doc.createElement('span');
    flag.className = 'sem-node-flag';
    el.appendChild(kind);
    el.appendChild(label);
    el.appendChild(flag);
    this.nodeLayer.appendChild(el);
    const rec = { el, label, kind, flag, timer: null, entered: false };
    if (doAnimate) {
      el.classList.add('sem-enter');
      rec.entered = true;
      rec.timer = this.#later(() => {
        el.classList.remove('sem-enter');
        rec.timer = null;
      }, 460);
    }
    return rec;
  }

  #updateNode(rec, spot, model, focused, isTarget, doAnimate) {
    if (rec.el.classList.contains('is-exiting')) {
      rec.el.classList.remove('is-exiting');
      if (rec.timer != null) this.#cancelLater(rec.timer);
      rec.timer = null;
      this.exiting.delete(spot.id);
      if (doAnimate) {
        rec.el.classList.add('sem-enter');
        rec.timer = this.#later(() => {
          rec.el.classList.remove('sem-enter');
          rec.timer = null;
        }, 460);
      }
    }
    const label = text(model.label);
    if (rec.label.textContent !== label) rec.label.textContent = label;
    const flag = [
      CLAIM_FLAGS[model.claim_kind] || '',
      model.state === 'tentative' ? '待确认' : '',
      model.state === 'stale' ? '待复核' : '',
      model.manual ? '人工' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    if (rec.flag.textContent !== flag) rec.flag.textContent = flag;
    rec.el.setAttribute('aria-label', `${label}${flag ? `，${flag}` : ''}；回车可更正`);
    rec.el.dataset.claimKind = text(model.claim_kind);
    rec.el.dataset.state = text(model.state);
    rec.el.dataset.role = text(model.role);
    rec.el.dataset.manual = model.manual ? 'true' : 'false';
    rec.el.classList.toggle('is-focus', focused);
    rec.el.classList.toggle('is-target', isTarget);
    rec.el.classList.toggle('is-tentative', model.state === 'tentative');
    rec.el.classList.toggle('is-stale', model.state === 'stale');
    rec.el.style.transform = `translate3d(${Math.round(spot.x)}px, ${Math.round(spot.y)}px, 0)`;
    rec.el.style.width = `${Math.round(spot.width)}px`;
    rec.el.style.height = `${Math.round(spot.height)}px`;
  }

  #reconcileEdges(placed, edgeById, doAnimate) {
    const keep = new Set();
    for (const spot of placed) {
      keep.add(spot.id);
      const model = edgeById[spot.id] || {};
      let rec = this.edgeEls.get(spot.id);
      if (!rec) {
        rec = this.#createEdge(spot.id, doAnimate);
        this.edgeEls.set(spot.id, rec);
      }
      this.#updateEdge(rec, spot, model, doAnimate);
    }
    for (const [id, rec] of [...this.edgeEls]) {
      if (keep.has(id)) continue;
      this.edgeEls.delete(id);
      this.#removeElement(id, rec, 'edge', doAnimate);
    }
  }

  #createEdge(id, doAnimate) {
    const g = this.doc.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'sem-edge');
    g.setAttribute('data-sem-id', id);
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.dataset.semId = id;
    const path = this.doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'sem-edge-line');
    path.setAttribute('pathLength', '1');
    path.setAttribute('marker-end', `url(#${this.markerId})`);
    const label = this.doc.createElementNS(SVG_NS, 'text');
    label.setAttribute('class', 'sem-edge-label');
    label.setAttribute('text-anchor', 'middle');
    g.appendChild(path);
    g.appendChild(label);
    this.edgeLayer.appendChild(g);
    const rec = { g, path, label, timer: null };
    if (doAnimate) {
      path.classList.add('sem-draw');
      rec.timer = this.#later(() => {
        path.classList.remove('sem-draw');
        rec.timer = null;
      }, 520);
    }
    return rec;
  }

  #updateEdge(rec, spot, model, doAnimate) {
    if (rec.g.classList.contains('is-exiting')) {
      rec.g.classList.remove('is-exiting');
      if (rec.timer != null) this.#cancelLater(rec.timer);
      rec.timer = null;
      this.exiting.delete(spot.id);
      if (doAnimate) rec.path.classList.add('sem-draw');
    }
    if (rec.path.getAttribute('d') !== spot.path) rec.path.setAttribute('d', spot.path);
    const marker = spot.arrow === false ? '' : `url(#${this.markerId})`;
    if (rec.path.getAttribute('marker-end') !== marker) rec.path.setAttribute('marker-end', marker);
    const word = spot.labelText !== undefined ? spot.labelText : relationWord(model.relation, model.label);
    if (rec.label.textContent !== word) rec.label.textContent = word;
    const x = Number.isFinite(spot.lx) ? spot.lx : spot.cx;
    const y = Number.isFinite(spot.ly) ? spot.ly : (spot.y1 + spot.y2) / 2 - 8;
    rec.label.setAttribute('x', String(Math.round(x)));
    rec.label.setAttribute('y', String(Math.round(y)));
    rec.g.dataset.relation = text(model.relation);
    rec.g.dataset.state = text(model.state);
    rec.g.dataset.dir = spot.dir;
    rec.g.dataset.manual = model.manual ? 'true' : 'false';
    rec.g.setAttribute('aria-label', `${word || '关系'}；回车可更正`);
    rec.g.classList.toggle('is-compare', spot.dir === 'compare');
    rec.g.classList.toggle('is-tentative', model.state === 'tentative' || model.claim_kind === 'hypothesis');
    rec.g.classList.toggle('is-stale', model.state === 'stale');
  }

  #removeElement(id, rec, kind, doAnimate) {
    const el = kind === 'node' ? rec.el : rec.g;
    const finish = () => {
      if (el.parentNode) el.parentNode.removeChild(el);
      this.exiting.delete(id);
    };
    if (rec.timer != null) this.#cancelLater(rec.timer);
    if (doAnimate) {
      el.classList.add('is-exiting');
      this.exiting.set(id, { rec, kind, timer: this.#later(finish, 280) });
      rec.timer = this.exiting.get(id).timer;
    } else {
      finish();
    }
  }

  #clearAll({ immediate = true } = {}) {
    for (const [id, rec] of this.groupEls) {
      if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
      this.groupEls.delete(id);
    }
    for (const [id, rec] of this.nodeEls) this.#removeElement(id, rec, 'node', false);
    for (const [id, rec] of this.edgeEls) this.#removeElement(id, rec, 'edge', false);
    for (const [, entry] of this.exiting) {
      if (entry.timer != null) this.#cancelLater(entry.timer);
      const el = entry.kind === 'node' ? entry.rec.el : entry.rec.g;
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    this.nodeEls.clear();
    this.edgeEls.clear();
    this.exiting.clear();
    if (immediate) {
      while (this.edgeLayer.firstChild) this.edgeLayer.removeChild(this.edgeLayer.firstChild);
    }
  }

  snapshot() {
    const layout = this.lastLayout || { nodes: [], edges: [] };
    return {
      scene_id: this.sceneId,
      title: this.titleEl.textContent,
      family: this.root.dataset.family || null,
      reduced_motion: this.reducedMotion,
      width: layout.width,
      height: layout.height,
      nodes: (layout.nodes || []).map((n) => ({ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height, text: this.nodeEls.get(n.id)?.label.textContent || '' })),
      edges: (layout.edges || []).map((e) => ({ id: e.id, d: e.path, relation: e.relation, dir: e.dir })),
      groups: (layout.groups || []).map((g) => ({ id: g.id, x: g.x, y: g.y, width: g.width, height: g.height })),
      capacity: layout.capacity || null,
      dom: { nodes: this.nodeEls.size, edges: this.edgeEls.size, groups: this.groupEls.size },
    };
  }

  /** Test/browser-check hook: identity map of live elements. */
  elements() {
    return { nodes: this.nodeEls, edges: this.edgeEls, groups: this.groupEls, root: this.root };
  }

  destroy() {
    for (const timer of this.timers) this.#cancelLater(timer);
    this.timers.clear();
    if (this.unobserve) this.unobserve();
    if (this.window && this.window.removeEventListener) this.window.removeEventListener('resize', this.onWindowResize);
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
  }
}

export { CLAIM_FLAGS };
