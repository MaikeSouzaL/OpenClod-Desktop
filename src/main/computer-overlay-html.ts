import { DEFAULT_LABEL, MASCOT_MOODS, type MascotMood } from '../core/computer/mood.js'
import { CURSOR_ARROW_DATA_URL } from './cursor-arrow.js'

/* ------------------------------------------------------------------ */
/* Look of each mood                                                   */
/* ------------------------------------------------------------------ */

/**
 * `led` is one rounded rectangle per eye whose size, corner radius, tilt and
 * height are CSS properties, so every mood morphs smoothly into the next
 * (squircle, flat pill, thin slit, big and round...). The others are drawn shapes.
 */
export const MASCOT_EYES = ['led', 'happy', 'chevron', 'spiral', 'star'] as const
/** The mouth is optional: a thin glowing line, used by very few moods. */
export const MASCOT_MOUTHS = ['none', 'smile', 'frown', 'o'] as const
export const MASCOT_EXTRAS = [
  'sweat',
  'sweat2',
  'question',
  'alert',
  'zzz',
  'think',
  'gear',
  'stars',
  'smoke',
  'glitch',
  'confetti',
  'tear',
  'relief'
] as const

export type MascotEyes = (typeof MASCOT_EYES)[number]
export type MascotMouth = (typeof MASCOT_MOUTHS)[number]
export type MascotExtra = (typeof MASCOT_EXTRAS)[number]
/** Where the eyes look: follow the agent pointer, or a fixed expressive direction. */
export type MascotGaze = 'free' | 'up' | 'down' | 'sweep' | 'read' | 'still'

/** Geometry of one LED eye in px / degrees (used when `eyes` is `led`). */
export interface LedShape {
  w: number
  h: number
  r: number
  rot: number
  dy: number
}

export interface MascotLook {
  eyes: MascotEyes
  led: [LedShape, LedShape]
  mouth: MascotMouth
  extras: MascotExtra[]
  gaze: MascotGaze
  /** Side pods: outward tilt in degrees and vertical offset in px, left/right (big dy = drooping). */
  ears: { rot: [number, number]; dy: [number, number] }
  /** Blush opacity on the screen. */
  cheek: number
  /** LED palette: top, middle and bottom colours plus the glow as "r, g, b". */
  color: { top: string; mid: string; bot: string; glow: string }
  /** Ear ring colour and spin period in seconds. */
  ring: string
  pulse: number
  /** Gear spin period in seconds; `hot` tints it red. */
  gear?: { speed: number; hot?: boolean }
  /** Pill dot colour when the mood has its own (otherwise it follows the difficulty). */
  dot?: string
  /** Body animation (keyframes `m-<mood>`). */
  motion: { duration: number; timing?: string; direction?: 'alternate' }
}

const AMBER = { top: '#ffc35a', mid: '#ff9a2e', bot: '#ff7a1a', glow: '255, 140, 40' }
const sq = (w: number, h: number, r: number, rot = 0, dy = 0): LedShape => ({ w, h, r, rot, dy })

export const MASCOT_LOOKS: Record<MascotMood, MascotLook> = {
  calm: {
    eyes: 'led', led: [sq(15, 18, 7), sq(15, 18, 7)], mouth: 'none', extras: [], gaze: 'free',
    ears: { rot: [8, 8], dy: [0, 0] }, cheek: 0.35, color: AMBER, ring: '#ff9a3a', pulse: 3.2,
    motion: { duration: 3.4 }
  },
  working: {
    eyes: 'led', led: [sq(16, 16, 5), sq(16, 16, 5)], mouth: 'none', extras: ['gear'], gaze: 'read',
    ears: { rot: [5, 5], dy: [-1, -1] }, cheek: 0.2,
    color: { top: '#ffd36b', mid: '#ff9a2e', bot: '#ff7a1a', glow: '255, 140, 40' }, ring: '#ff8a2a', pulse: 1.6,
    gear: { speed: 3.2 }, motion: { duration: 1.4, timing: 'ease-out' }
  },
  thinking: {
    eyes: 'led', led: [sq(14, 18, 6.5), sq(14, 18, 6.5)], mouth: 'none', extras: ['think'], gaze: 'up',
    ears: { rot: [10, 2], dy: [0, -3] }, cheek: 0.2,
    color: { top: '#e2f6ff', mid: '#8fdcff', bot: '#4fbfff', glow: '90, 200, 255' }, ring: '#6cd4ff', pulse: 2,
    motion: { duration: 3.2 }
  },
  curious: {
    eyes: 'led', led: [sq(18, 22, 8.5), sq(18, 22, 8.5)], mouth: 'none', extras: [], gaze: 'free',
    ears: { rot: [3, 3], dy: [-5, -5] }, cheek: 0.45,
    color: { top: '#fff0b0', mid: '#ffc04a', bot: '#ff9a2e', glow: '255, 170, 60' }, ring: '#ffd36b', pulse: 1.6,
    motion: { duration: 2.6 }
  },
  waiting: {
    eyes: 'led', led: [sq(19, 9, 4.5, 0, 1), sq(19, 9, 4.5, 0, 1)], mouth: 'none', extras: ['sweat'], gaze: 'sweep',
    ears: { rot: [10, 10], dy: [1, 1] }, cheek: 0.15,
    color: { top: '#ffc35a', mid: '#ffa030', bot: '#ff8f2a', glow: '255, 150, 40' }, ring: '#ffb02e', pulse: 0.9,
    motion: { duration: 2.2 }
  },
  sleepy: {
    eyes: 'led', led: [sq(16, 4, 2, -8, 3), sq(16, 4, 2, 8, 3)], mouth: 'none', extras: ['zzz'], gaze: 'still',
    ears: { rot: [34, 34], dy: [9, 9] }, cheek: 0.45,
    color: { top: '#d9a468', mid: '#b97a38', bot: '#8a4a14', glow: '170, 100, 40' }, ring: '#a98258', pulse: 6,
    motion: { duration: 5 }
  },
  confused: {
    eyes: 'led', led: [sq(18, 20, 7.5, -10, -1), sq(12, 13, 5, 8, 2)], mouth: 'none', extras: ['question'], gaze: 'free',
    ears: { rot: [20, 2], dy: [2, -4] }, cheek: 0.2, color: AMBER, ring: '#ffa24d', pulse: 1.4,
    motion: { duration: 2.8 }
  },
  struggling: {
    eyes: 'chevron', led: [sq(14, 14, 4), sq(14, 14, 4)], mouth: 'none', extras: ['sweat', 'gear'], gaze: 'free',
    ears: { rot: [14, 14], dy: [3, 3] }, cheek: 0.5,
    color: { top: '#ffa070', mid: '#ff6a3a', bot: '#e63a1a', glow: '255, 90, 50' }, ring: '#ff5a2a', pulse: 0.5,
    gear: { speed: 0.6, hot: true }, motion: { duration: 0.22, timing: 'linear' }
  },
  overwhelmed: {
    eyes: 'spiral', led: [sq(14, 14, 5), sq(14, 14, 5)], mouth: 'none', extras: ['stars', 'smoke', 'glitch', 'sweat', 'sweat2'], gaze: 'still',
    ears: { rot: [22, 22], dy: [5, 5] }, cheek: 0.5,
    color: { top: '#ff8a7a', mid: '#ff4a40', bot: '#d1121a', glow: '255, 50, 50' }, ring: '#ff2e2e', pulse: 0.36,
    motion: { duration: 1.8 }
  },
  worried: {
    eyes: 'led', led: [sq(12, 16, 5.5, -14, -1), sq(12, 16, 5.5, 14, -1)], mouth: 'none', extras: ['alert'], gaze: 'free',
    ears: { rot: [4, 4], dy: [-2, -2] }, cheek: 0.1,
    color: { top: '#f2faff', mid: '#c4deff', bot: '#8fb8ff', glow: '150, 190, 255' }, ring: '#bfe0ff', pulse: 0.42,
    motion: { duration: 0.14, timing: 'linear' }
  },
  asking: {
    eyes: 'led', led: [sq(19, 23, 9, 0, 1), sq(19, 23, 9, 0, 1)], mouth: 'none', extras: ['question'], gaze: 'down',
    ears: { rot: [8, 0], dy: [0, -9] }, cheek: 0.35,
    color: { top: '#d2f0ff', mid: '#7ccaff', bot: '#4aa8ff', glow: '80, 170, 255' }, ring: '#6cc8ff', pulse: 0.8,
    dot: '#5db8ff', motion: { duration: 1.4 }
  },
  relieved: {
    eyes: 'happy', led: [sq(14, 12, 6), sq(14, 12, 6)], mouth: 'o', extras: ['relief', 'sweat'], gaze: 'still',
    ears: { rot: [26, 26], dy: [6, 6] }, cheek: 0.5,
    color: { top: '#fff4c8', mid: '#ffd988', bot: '#ffc04a', glow: '255, 200, 90' }, ring: '#ffe39a', pulse: 2.6,
    dot: '#4ade80', motion: { duration: 2.6, direction: 'alternate' }
  },
  happy: {
    eyes: 'happy', led: [sq(14, 12, 6), sq(14, 12, 6)], mouth: 'smile', extras: ['confetti'], gaze: 'still',
    ears: { rot: [0, 0], dy: [-7, -7] }, cheek: 0.85,
    color: { top: '#ffe27a', mid: '#ffb02e', bot: '#ff8a10', glow: '255, 160, 30' }, ring: '#ffd23f', pulse: 0.7,
    dot: '#4ade80', motion: { duration: 0.9 }
  },
  sad: {
    eyes: 'led', led: [sq(15, 14, 6.5, -18, 2), sq(15, 14, 6.5, 18, 2)], mouth: 'frown', extras: ['tear'], gaze: 'down',
    ears: { rot: [36, 36], dy: [9, 9] }, cheek: 0.2,
    color: { top: '#bcd4ff', mid: '#7a9cf0', bot: '#4a6fd0', glow: '90, 130, 230' }, ring: '#5b7fd0', pulse: 7,
    motion: { duration: 5.4 }
  }
}

/* ------------------------------------------------------------------ */
/* Small geometry helpers                                              */
/* ------------------------------------------------------------------ */

const f = (n: number): string => String(Math.round(n * 100) / 100)

/** |x/a|^n + |y/b|^n = 1: the "squircle" of the head and of the screen. */
function superellipse(cx: number, cy: number, a: number, b: number, n: number, steps = 120): string {
  let d = ''
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const c = Math.cos(t)
    const s = Math.sin(t)
    const x = cx + a * Math.sign(c) * Math.abs(c) ** (2 / n)
    const y = cy + b * Math.sign(s) * Math.abs(s) ** (2 / n)
    d += `${i === 0 ? 'M' : 'L'}${f(x)} ${f(y)}`
  }
  return `${d}Z`
}

function starPath(R: number, r: number, points = 5): string {
  let d = ''
  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 === 0 ? R : r
    const a = (Math.PI / points) * i - Math.PI / 2
    d += `${i === 0 ? 'M' : 'L'}${f(Math.cos(a) * radius)} ${f(Math.sin(a) * radius)}`
  }
  return `${d}Z`
}

function gearPath(teeth: number, outer: number, inner: number): string {
  const step = (Math.PI * 2) / teeth
  let d = ''
  for (let i = 0; i < teeth; i++) {
    const a = i * step
    const corners: Array<[number, number]> = [
      [inner, a - step * 0.27],
      [outer, a - step * 0.15],
      [outer, a + step * 0.15],
      [inner, a + step * 0.27]
    ]
    for (const [radius, angle] of corners) {
      d += `${d ? 'L' : 'M'}${f(Math.cos(angle) * radius)} ${f(Math.sin(angle) * radius)}`
    }
  }
  return `${d}Z`
}

function spiralPath(turns: number, maxRadius: number): string {
  const steps = 60
  let d = ''
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * turns * Math.PI * 2
    const r = (i / steps) * maxRadius
    d += `${i === 0 ? 'M' : 'L'}${f(Math.cos(t) * r)} ${f(Math.sin(t) * r)}`
  }
  return d
}

const HEAD = superellipse(90, 72, 41, 39, 2.7)
const SCREEN = superellipse(90, 72.5, 33.5, 27, 2.9)
const STAR5 = starPath(10.5, 4.5)
const STAR_SMALL = starPath(6.4, 2.7)
const SPARKLE = starPath(6.2, 1.7, 4)
const GEAR_BIG = gearPath(8, 11, 8.3)
const GEAR_SMALL = gearPath(6, 7, 5.2)
const SPIRAL = spiralPath(2.6, 8)
const DROP = 'M0 -7.5 C-1.2 -3.4 -5.2 -0.2 -5.2 3.6 A5.2 5.2 0 0 0 5.2 3.6 C5.2 -0.2 1.2 -3.4 0 -7.5 Z'

/* ------------------------------------------------------------------ */
/* SVG pieces                                                          */
/* ------------------------------------------------------------------ */

const LED_X = 17
const LED_Y = 69

function eyeSlot(side: 'l' | 'r'): string {
  const x = side === 'l' ? 90 - LED_X : 90 + LED_X
  const flip = side === 'r' ? ' transform="scale(-1 1)"' : ''
  return `<g transform="translate(${x} ${LED_Y})"><g class="slot-${side}"><g class="eye-wrap">
          <g class="ev ev-led"><g class="gaze"><g class="led-pose led-pose-${side}">
            <rect class="led led-${side}" x="-7" y="-8.5" width="14" height="17" rx="6.5" ry="6.5" fill="url(#g-led)"/>
            <rect class="glint glint-${side}" x="-4.6" y="-6.3" width="4.8" height="3.4" rx="1.7" ry="1.7" fill="#fff" opacity="0.88"/>
          </g></g></g>
          <g class="ev ev-happy"><g class="gaze">
            <path d="M-8 3.4 Q0 -8.6 8 3.4" fill="none" stroke="var(--led-mid)" stroke-width="4" stroke-linecap="round"/>
          </g></g>
          <g class="ev ev-chevron"><g class="gaze"><g${flip}>
            <path d="M-6.4 -7.4 L5.6 0 L-6.4 7.4" fill="none" stroke="var(--led-top)" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/>
          </g></g></g>
          <g class="ev ev-spiral"><g class="gaze"><g${flip}>
            <path class="spin" d="${SPIRAL}" fill="none" stroke="var(--led-top)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
          </g></g></g>
          <g class="ev ev-star"><g class="gaze"><g class="pulse">
            <path d="${STAR5}" fill="url(#g-led)" stroke="rgba(255,255,255,0.55)" stroke-width="0.8" stroke-linejoin="round"/>
          </g></g></g>
        </g></g></g>`
}

function ringSvg(x: number): string {
  return `<g class="ring" transform="translate(${x} 67)">
          <circle r="7.4" fill="#151a2c" stroke="rgba(255,255,255,0.45)" stroke-width="0.8"/>
          <circle class="ring-spin" r="4.7" fill="none" stroke="var(--ring)" stroke-width="2.3" stroke-linecap="round" stroke-dasharray="10 4.8"/>
          <circle class="ring-core" r="1.6" fill="var(--ring)"/>
        </g>`
}

function earSvg(side: 'l' | 'r'): string {
  const x = side === 'l' ? 33 : 125
  const ringX = side === 'l' ? 41 : 139
  const glossX = side === 'l' ? 39 : 134
  return `<g class="ear ear-${side}"><g class="ear-in">
        <rect x="${x}" y="47" width="22" height="40" rx="11" fill="url(#g-pearl)" stroke="rgba(94,80,66,0.4)" stroke-width="1"/>
        <rect x="${x}" y="47" width="22" height="40" rx="11" fill="url(#g-glow)"/>
        <ellipse cx="${glossX}" cy="55.5" rx="3.2" ry="5.4" fill="#fff" opacity="0.75"/>
        ${ringSvg(ringX)}
      </g></g>`
}

const MOUTHS = `
          <g class="mv mv-smile"><path d="M-6.5 0 Q0 6.4 6.5 0" fill="none" stroke="var(--led-mid)" stroke-width="2.8" stroke-linecap="round"/></g>
          <g class="mv mv-frown"><path d="M-6 4 Q0 -2.6 6 4" fill="none" stroke="var(--led-mid)" stroke-width="2.8" stroke-linecap="round"/></g>
          <g class="mv mv-o"><ellipse rx="2.9" ry="3.4" cy="1.5" fill="none" stroke="var(--led-mid)" stroke-width="2.4"/></g>`

function dropAt(cls: string, x: number, y: number, delay = 0): string {
  return `<g transform="translate(${x} ${y})"><g class="${cls}" style="animation-delay:${delay}s">
        <path d="${DROP}" fill="url(#g-drop)" stroke="#2a86c4" stroke-width="0.9" stroke-linejoin="round"/>
        <ellipse cx="-1.8" cy="2" rx="1.1" ry="1.9" fill="#fff" opacity="0.8" transform="rotate(14 -1.8 2)"/>
      </g></g>`
}

function orbitStar(angle: number): string {
  return `<g class="orb" style="--a:${angle}deg"><g transform="translate(34 0)"><g class="orb-c" style="--a:${angle}deg"><g transform="scale(1 4.5)">
        <path d="${STAR_SMALL}" fill="url(#g-starfill)" stroke="#d9780c" stroke-width="0.9" stroke-linejoin="round"/>
      </g></g></g></g>`
}

const CONFETTI: Array<{ x: number; y: number; color: string; shape: 'r' | 'c'; delay: number }> = [
  { x: 40, y: 30, color: '#ffd23f', shape: 'r', delay: 0 },
  { x: 60, y: 10, color: '#ff7a1a', shape: 'c', delay: 0.2 },
  { x: 122, y: 8, color: '#5ee1a4', shape: 'r', delay: 0.4 },
  { x: 148, y: 28, color: '#5db8ff', shape: 'c', delay: 0.1 },
  { x: 160, y: 66, color: '#ff8aa0', shape: 'r', delay: 0.5 },
  { x: 20, y: 60, color: '#5db8ff', shape: 'r', delay: 0.3 },
  { x: 28, y: 100, color: '#ffd23f', shape: 'c', delay: 0.6 },
  { x: 154, y: 102, color: '#ff7a1a', shape: 'r', delay: 0.15 },
  { x: 76, y: 5, color: '#ff8aa0', shape: 'c', delay: 0.35 },
  { x: 106, y: 18, color: '#ffd23f', shape: 'r', delay: 0.55 }
]

const SPARKLES: Array<[number, number, number]> = [
  [34, 40, 0],
  [146, 44, 0.5],
  [152, 88, 0.9],
  [26, 82, 1.3]
]

function confettiSvg(): string {
  const pieces = CONFETTI.map((p) => {
    const shape =
      p.shape === 'r'
        ? `<rect x="-2" y="-3.6" width="4" height="7.2" rx="1" fill="${p.color}"/>`
        : `<circle r="2.5" fill="${p.color}"/>`
    return `<g transform="translate(${p.x} ${p.y})"><g class="cf" style="animation-delay:-${p.delay}s">${shape}</g></g>`
  }).join('\n        ')
  const sparkles = SPARKLES.map(
    ([x, y, delay]) =>
      `<g transform="translate(${x} ${y})"><g class="sparkle" style="animation-delay:-${delay}s"><path d="${SPARKLE}" fill="#fff6c9" stroke="#ffb02e" stroke-width="1" stroke-linejoin="round"/></g></g>`
  ).join('\n        ')
  return `${pieces}\n        ${sparkles}`
}

const EXTRAS_SVG = `
      <g class="x x-sweat">${dropAt('drip', 121, 41)}</g>
      <g class="x x-sweat2">${dropAt('drip', 59, 43, 0.8)}</g>
      <g class="x x-question" transform="translate(141 19)"><g class="bubble">
        <path d="M-6.5 8.5 L-14 17 L1.5 11.5 Z" fill="#fff8ee" stroke="#ff7a1a" stroke-width="2" stroke-linejoin="round"/>
        <circle r="11.4" fill="#fff8ee" stroke="#ff7a1a" stroke-width="2"/>
        <path d="M-6.5 8.5 L-14 17 L1.5 11.5 Z" fill="#fff8ee"/>
        <text x="0" y="5.4" text-anchor="middle" font-size="16" font-weight="800" fill="#e0620d">?</text>
      </g></g>
      <g class="x x-alert" transform="translate(141 19)"><g class="bubble alarm">
        <path d="M-6.5 8.5 L-14 17 L1.5 11.5 Z" fill="#fff1ec" stroke="#ff4a2a" stroke-width="2" stroke-linejoin="round"/>
        <circle r="11.4" fill="#fff1ec" stroke="#ff4a2a" stroke-width="2"/>
        <path d="M-6.5 8.5 L-14 17 L1.5 11.5 Z" fill="#fff1ec"/>
        <text x="0" y="5.4" text-anchor="middle" font-size="16" font-weight="800" fill="#e23a1d">!</text>
      </g></g>
      <g class="x x-zzz" font-family="'Segoe UI', system-ui, sans-serif" font-weight="800" fill="#c9d3ff" stroke="rgba(30,24,40,0.6)" stroke-width="2.6" paint-order="stroke" stroke-linejoin="round">
        <text class="z z1" x="124" y="42" font-size="11" text-anchor="middle">z</text>
        <text class="z z2" x="137" y="28" font-size="14" text-anchor="middle">Z</text>
        <text class="z z3" x="151" y="13" font-size="18" text-anchor="middle">Z</text>
      </g>
      <g class="x x-think">
        <g class="thought">
          <g fill="#ff7a1a" stroke="#ff7a1a" stroke-width="3.4" stroke-linejoin="round">
            <circle cx="126" cy="38" r="2.6"/><circle cx="131" cy="30" r="3.6"/>
            <circle cx="140" cy="19.5" r="7"/><circle cx="148" cy="14.5" r="8.6"/><circle cx="157" cy="18.5" r="7.4"/><circle cx="149" cy="22.5" r="8"/>
          </g>
          <g fill="#fff8ee">
            <circle cx="126" cy="38" r="2.6"/><circle cx="131" cy="30" r="3.6"/>
            <circle cx="140" cy="19.5" r="7"/><circle cx="148" cy="14.5" r="8.6"/><circle cx="157" cy="18.5" r="7.4"/><circle cx="149" cy="22.5" r="8"/>
          </g>
          <g fill="#ff7a1a">
            <circle class="td td1" cx="141" cy="19.5" r="2.4"/>
            <circle class="td td2" cx="149" cy="19.5" r="2.4"/>
            <circle class="td td3" cx="157" cy="19.5" r="2.4"/>
          </g>
        </g>
      </g>
      <g class="x x-gear">
        <g transform="translate(154 24)"><g class="gear gear-a">
          <path d="${GEAR_BIG}" fill="url(#g-gear)" stroke="#9a3f08" stroke-width="1" stroke-linejoin="round"/>
          <circle r="3.6" fill="#fff3e3" stroke="#9a3f08" stroke-width="1"/>
        </g></g>
        <g transform="translate(170 40)"><g class="gear gear-b">
          <path d="${GEAR_SMALL}" fill="url(#g-gear)" stroke="#9a3f08" stroke-width="1" stroke-linejoin="round"/>
          <circle r="2.2" fill="#fff3e3" stroke="#9a3f08" stroke-width="0.9"/>
        </g></g>
      </g>
      <g class="x x-stars">
        <g transform="translate(90 27) scale(1 0.22)">${orbitStar(30)}${orbitStar(150)}${orbitStar(270)}</g>
      </g>
      <g class="x x-smoke" fill="#e2dbd1" stroke="rgba(120,108,96,0.35)" stroke-width="1">
        <g transform="translate(48 40)"><circle class="puff" r="5.5"/></g>
        <g transform="translate(132 40)"><circle class="puff p2" r="5"/></g>
        <g transform="translate(41 30)"><circle class="puff p3" r="3.6"/></g>
      </g>
      <g class="x x-confetti">
        ${confettiSvg()}
      </g>
      <g class="x x-tear">${dropAt('weep', 69, 83)}${dropAt('weep', 111, 85, 1.1)}</g>
      <g class="x x-relief">
        <g transform="translate(122 104)"><g class="puffcloud">
          <g fill="#ffffff" stroke="rgba(120,108,96,0.4)" stroke-width="1">
            <circle cx="0" cy="0" r="4.2"/><circle cx="6" cy="-2.4" r="5.4"/><circle cx="12.4" cy="0.6" r="4.4"/>
          </g>
          <g fill="#ffffff"><circle cx="0.4" cy="0" r="3.8"/><circle cx="6" cy="-2.4" r="5"/><circle cx="12" cy="0.6" r="4"/></g>
        </g></g>
      </g>`

const MASCOT_SVG = `<svg class="mascot-svg" viewBox="0 0 180 124" width="180" height="124" data-eyes="led" data-mouth="none" data-extras="">
    <defs>
      <radialGradient id="g-pearl" cx="36%" cy="26%" r="84%">
        <stop offset="0" stop-color="#ffffff"/>
        <stop offset="0.3" stop-color="#fcf8f1"/>
        <stop offset="0.62" stop-color="#ece3d8"/>
        <stop offset="0.86" stop-color="#cfc2b2"/>
        <stop offset="1" stop-color="#b6a794"/>
      </radialGradient>
      <radialGradient id="g-glow" cx="0.84" cy="0.92" r="0.6">
        <stop offset="0" stop-color="#ff7a1a" stop-opacity="0.5"/>
        <stop offset="0.6" stop-color="#ff9a4a" stop-opacity="0.14"/>
        <stop offset="1" stop-color="#ff7a1a" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="g-rim" x1="0.1" y1="0.1" x2="0.9" y2="0.9">
        <stop offset="0.5" stop-color="#ff7a1a" stop-opacity="0"/>
        <stop offset="1" stop-color="#ff7a1a" stop-opacity="0.9"/>
      </linearGradient>
      <linearGradient id="g-screen" x1="0.1" y1="0" x2="0.9" y2="1">
        <stop offset="0" stop-color="#26324f"/>
        <stop offset="0.5" stop-color="#101728"/>
        <stop offset="1" stop-color="#070a12"/>
      </linearGradient>
      <linearGradient id="g-led" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style="stop-color: var(--led-top, #ffc35a)"/>
        <stop offset="1" style="stop-color: var(--led-bot, #ff7a1a)"/>
      </linearGradient>
      <linearGradient id="g-starfill" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#ffe266"/>
        <stop offset="1" stop-color="#ff9a1a"/>
      </linearGradient>
      <radialGradient id="g-cheek">
        <stop offset="0" stop-color="#ff7f9a" stop-opacity="0.95"/>
        <stop offset="1" stop-color="#ff7f9a" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="g-halo">
        <stop offset="0" style="stop-color: rgb(var(--halo, 255, 122, 26)); stop-opacity: 0.34"/>
        <stop offset="1" style="stop-color: rgb(var(--halo, 255, 122, 26)); stop-opacity: 0"/>
      </radialGradient>
      <linearGradient id="g-drop" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#c9efff"/>
        <stop offset="1" stop-color="#4db8ff"/>
      </linearGradient>
      <linearGradient id="g-gear" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" style="stop-color: var(--gear-top, #ffb066)"/>
        <stop offset="1" style="stop-color: var(--gear-bot, #e8620d)"/>
      </linearGradient>
      <pattern id="p-scan" width="4" height="4" patternUnits="userSpaceOnUse">
        <rect width="4" height="1.5" fill="#ff6a6a" opacity="0.3"/>
      </pattern>
      <clipPath id="c-screen"><path d="${SCREEN}"/></clipPath>
      <filter id="f-soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.2"/></filter>
      <filter id="f-shadow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="6"/></filter>
    </defs>

    <ellipse class="halo" cx="90" cy="70" rx="68" ry="56" fill="url(#g-halo)"/>
    <ellipse cx="90" cy="84" rx="38" ry="36" fill="#000" opacity="0.3" filter="url(#f-shadow)"/>

    <g class="rig"><g class="pop">
      ${earSvg('l')}
      ${earSvg('r')}

      <g class="head">
        <path d="${HEAD}" fill="url(#g-pearl)" stroke="rgba(94,80,66,0.4)" stroke-width="1" stroke-linejoin="round"/>
        <path d="${HEAD}" fill="url(#g-glow)"/>
        <path d="${HEAD}" transform="translate(90 72) scale(0.965) translate(-90 -72)" fill="none" stroke="url(#g-rim)" stroke-width="2.6" stroke-linejoin="round"/>
        <ellipse cx="68" cy="43.5" rx="15" ry="5.6" fill="#fff" opacity="0.8" transform="rotate(-24 68 43.5)" filter="url(#f-soft)"/>

        <g class="screen">
          <path d="${SCREEN}" fill="url(#g-screen)" stroke="rgba(8,10,18,0.9)" stroke-width="2.4" stroke-linejoin="round"/>
          <g clip-path="url(#c-screen)">
            <ellipse cx="90" cy="96" rx="34" ry="12" fill="rgb(var(--led-glow, 255, 140, 40))" opacity="0.09" filter="url(#f-soft)"/>
            <ellipse class="cheek" cx="62" cy="86" rx="6.4" ry="3.4" fill="url(#g-cheek)"/>
            <ellipse class="cheek" cx="118" cy="86" rx="6.4" ry="3.4" fill="url(#g-cheek)"/>
            <g class="eyes">
              ${eyeSlot('l')}
              ${eyeSlot('r')}
            </g>
            <g transform="translate(90 88)"><g class="mouth">${MOUTHS}
            </g></g>
            <g class="glitch">
              <rect x="50" y="40" width="80" height="66" fill="url(#p-scan)"/>
              <rect class="scanbar" x="50" y="40" width="80" height="6" fill="#ff8a8a" opacity="0.28"/>
            </g>
            <path d="M58 46 L97 46 L67 100 L56 100 Z" fill="#fff" opacity="0.045"/>
            <path d="M103 46 L110 46 L80 100 L73 100 Z" fill="#fff" opacity="0.03"/>
            <ellipse cx="82" cy="52" rx="22" ry="4.2" fill="#fff" opacity="0.07"/>
          </g>
          <path d="${SCREEN}" transform="translate(90 72.5) scale(0.955) translate(-90 -72.5)" fill="none" stroke="rgba(140,170,255,0.26)" stroke-width="0.9" stroke-linejoin="round"/>
        </g>
      </g>
    </g></g>

    <g class="extras">${EXTRAS_SVG}
    </g>
  </svg>`

/* ------------------------------------------------------------------ */
/* CSS generated from the look table                                   */
/* ------------------------------------------------------------------ */

const KEYFRAMES = `
  @keyframes m-calm {
    0%, 100% { transform: translateY(0) rotate(-2.2deg) scale(1, 1); } 25% { transform: translateY(-3px) rotate(0deg) scale(1.01, 1.02); }
    50% { transform: translateY(-6px) rotate(2.2deg) scale(1.02, 1.045); } 75% { transform: translateY(-3px) rotate(0deg) scale(1.01, 1.02); }
  }
  @keyframes m-working {
    0%, 100% { transform: translateY(-2px) rotate(0deg) scale(1.01, 1.02); }
    12% { transform: translateY(5px) rotate(-3deg) scale(1.02, 0.96); } 24% { transform: translateY(-1px) rotate(0deg); }
    36% { transform: translateY(5px) rotate(3deg) scale(1.02, 0.96); } 48% { transform: translateY(-1px) rotate(0deg); }
    62% { transform: translateY(-5px) rotate(0deg) scale(0.99, 1.05); } 80% { transform: translateY(1px) rotate(-1.5deg); }
  }
  @keyframes m-thinking { 0%, 100% { transform: rotate(-8deg) translate(-3px, 1px); } 50% { transform: rotate(8deg) translate(3px, -4px); } }
  @keyframes m-curious {
    0%, 100% { transform: rotate(-9deg) translateY(0) scale(1, 1); } 30% { transform: rotate(-15deg) translateY(-5px) scale(1.03, 1.05); }
    65% { transform: rotate(8deg) translateY(-2px) scale(1.02, 1.03); }
  }
  @keyframes m-waiting {
    0%, 30%, 60%, 100% { transform: rotate(0deg) translateY(0); }
    15% { transform: rotate(-5deg) translateY(1px); } 45% { transform: rotate(5deg) translateY(1px); }
    72% { transform: rotate(0deg) translateY(-2px); } 82% { transform: rotate(0deg) translateY(0); }
  }
  @keyframes m-sleepy {
    0%, 100% { transform: rotate(0deg) translateY(0); }
    42% { transform: rotate(6deg) translateY(4px); } 58% { transform: rotate(10deg) translateY(7px); }
    63% { transform: rotate(-3deg) translateY(0); } 70% { transform: rotate(2deg) translateY(1px); } 82% { transform: rotate(0deg) translateY(0); }
  }
  @keyframes m-confused { 0%, 100% { transform: rotate(-9deg); } 50% { transform: rotate(9deg); } }
  @keyframes m-struggling {
    0%, 100% { transform: translate(0, 0) rotate(0deg); } 25% { transform: translate(-1.3px, 0.6px) rotate(-0.7deg); }
    50% { transform: translate(1.3px, -0.5px) rotate(0.7deg); } 75% { transform: translate(-0.9px, 0.4px) rotate(-0.4deg); }
  }
  @keyframes m-overwhelmed {
    0%, 100% { transform: rotate(-10deg) translate(-3px, 0); } 25% { transform: rotate(0deg) translate(0, 3px); }
    50% { transform: rotate(10deg) translate(3px, 0); } 75% { transform: rotate(0deg) translate(0, 3px); }
  }
  @keyframes m-worried {
    0%, 100% { transform: translate(0, 0) scale(0.97); } 20% { transform: translate(-1.8px, 0) scale(0.97); }
    40% { transform: translate(1.8px, 0.6px) scale(0.97); } 60% { transform: translate(-1.4px, -0.5px) scale(0.97); }
    80% { transform: translate(1.4px, 0) scale(0.97); }
  }
  @keyframes m-asking {
    0%, 56%, 100% { transform: translateY(0) scale(1, 1); } 22% { transform: translateY(-9px) scale(0.97, 1.05); }
    44% { transform: translateY(0) scale(1.05, 0.94); }
  }
  @keyframes m-relieved { 0% { transform: translateY(-2px) scale(1.05, 1.06); } 100% { transform: translateY(3px) scale(0.96, 0.94); } }
  @keyframes m-happy {
    0%, 72%, 100% { transform: translateY(0) scale(1, 1); } 25% { transform: translateY(-11px) scale(0.96, 1.06); }
    45% { transform: translateY(0) scale(1.07, 0.92); } 60% { transform: translateY(-3px) scale(1, 1); }
  }
  @keyframes m-sad {
    0%, 100% { transform: translateY(4px) scale(0.97, 0.95) rotate(0deg); } 40% { transform: translateY(5px) scale(0.97, 0.94) rotate(0deg); }
    44% { transform: translateY(5px) scale(0.97, 0.94) rotate(1.6deg); } 48% { transform: translateY(5px) scale(0.97, 0.94) rotate(-1.6deg); }
    52% { transform: translateY(5px) scale(0.97, 0.94) rotate(1.2deg); } 56% { transform: translateY(5px) scale(0.97, 0.94) rotate(0deg); }
  }`

function moodCss(): string {
  return MASCOT_MOODS.map((mood) => {
    const look = MASCOT_LOOKS[mood]
    const vars = [
      `--led-top: ${look.color.top}`,
      `--led-mid: ${look.color.mid}`,
      `--led-bot: ${look.color.bot}`,
      `--led-glow: ${look.color.glow}`,
      `--ring: ${look.ring}`,
      `--ring-speed: ${look.pulse}s`,
      `--cheek: ${look.cheek}`,
      `--ear-rot-l: ${look.ears.rot[0]}deg`,
      `--ear-rot-r: ${look.ears.rot[1]}deg`,
      `--ear-dy-l: ${look.ears.dy[0]}px`,
      `--ear-dy-r: ${look.ears.dy[1]}px`
    ]
    ;(['l', 'r'] as const).forEach((side, i) => {
      const led = look.led[i]
      vars.push(
        `--w-${side}: ${led.w}px`,
        `--h-${side}: ${led.h}px`,
        `--r-${side}: ${led.r}px`,
        `--rot-${side}: ${led.rot}deg`,
        `--dy-${side}: ${led.dy}px`
      )
    })
    if (look.gear) {
      vars.push(`--gear-speed: ${look.gear.speed}s`)
      if (look.gear.hot) vars.push('--gear-top: #ff8a6a', '--gear-bot: #d12a14')
    }
    if (look.dot) vars.push(`--dot: ${look.dot}`)
    const m = look.motion
    const animation = `m-${mood} ${m.duration}s ${m.timing ?? 'ease-in-out'} infinite${m.direction ? ` ${m.direction}` : ''}`
    return `  body[data-mood="${mood}"] { ${vars.join('; ')}; }
  body[data-mood="${mood}"] .rig { animation: ${animation}; }`
  }).join('\n')
}

function variantCss(): string {
  const eyes = MASCOT_EYES.map((kind) => `  .mascot-svg[data-eyes="${kind}"] .ev-${kind} { display: inline; }`)
  const mouths = MASCOT_MOUTHS.filter((kind) => kind !== 'none').map(
    (kind) => `  .mascot-svg[data-mouth="${kind}"] .mv-${kind} { display: inline; }`
  )
  const extras = MASCOT_EXTRAS.map((kind) => `  .mascot-svg[data-extras~="${kind}"] .x-${kind} { display: inline; }`)
  return [...eyes, ...mouths, ...extras, '  .mascot-svg[data-extras~="glitch"] .glitch { display: inline; }'].join('\n')
}

/** What the page script needs to know about each mood (the rest is CSS). */
function scriptLooks(): string {
  const table: Record<string, { eyes: string; mouth: string; extras: string; gaze: string }> = {}
  for (const mood of MASCOT_MOODS) {
    const look = MASCOT_LOOKS[mood]
    table[mood] = { eyes: look.eyes, mouth: look.mouth, extras: look.extras.join(' '), gaze: look.gaze }
  }
  return JSON.stringify(table)
}

/* ------------------------------------------------------------------ */
/* The page                                                            */
/* ------------------------------------------------------------------ */

export function overlayHtml(primary: boolean): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="dark">
<style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; pointer-events: none; }
  body {
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    --halo: 255, 122, 26;
    --dot: #ff7a1a;
    --led-top: #ffc35a; --led-mid: #ff9a2e; --led-bot: #ff7a1a; --led-glow: 255, 140, 40;
    --ring: #ff9a3a; --ring-speed: 3.2s; --cheek: 0.35;
    --ear-rot-l: 8deg; --ear-rot-r: 8deg; --ear-dy-l: 0px; --ear-dy-r: 0px;
    --w-l: 14px; --h-l: 17px; --r-l: 6.5px; --rot-l: 0deg; --dy-l: 0px;
    --w-r: 14px; --h-r: 17px; --r-r: 6.5px; --rot-r: 0deg; --dy-r: 0px;
    --gear-speed: 3s; --gear-top: #ffb066; --gear-bot: #e8620d;
  }
  body[data-difficulty="1"] { --dot: #ffb02e; --halo: 255, 160, 40; }
  body[data-difficulty="2"] { --dot: #ff6a3a; --halo: 255, 98, 30; }
  body[data-difficulty="3"] { --dot: #ff3b3b; --halo: 255, 56, 44; }
  body.paused *, body.paused *::before, body.paused *::after { animation-play-state: paused !important; }

  /* Soft orange light coming from every screen edge and fading inward. */
  .frame {
    --c: 255, 118, 20; --c2: 255, 142, 50;
    position: absolute; inset: 0; border-radius: 16px; pointer-events: none; overflow: hidden;
    background:
      linear-gradient(90deg, rgba(var(--c), 0.48) 0%, rgba(var(--c), 0.16) 4%, rgba(var(--c), 0) 13%) left / 13% 100% no-repeat,
      linear-gradient(270deg, rgba(var(--c), 0.48) 0%, rgba(var(--c), 0.16) 4%, rgba(var(--c), 0) 13%) right / 13% 100% no-repeat,
      linear-gradient(180deg, rgba(var(--c), 0.44) 0%, rgba(var(--c), 0.14) 4%, rgba(var(--c), 0) 13%) top / 100% 13% no-repeat,
      linear-gradient(0deg, rgba(var(--c), 0.44) 0%, rgba(var(--c), 0.14) 4%, rgba(var(--c), 0) 13%) bottom / 100% 13% no-repeat;
    box-shadow:
      inset 0 0 34px rgba(var(--c), 0.16),
      inset 0 0 120px rgba(var(--c), 0.07);
    animation: glow 3.6s ease-in-out infinite;
  }
  .frame::before {
    content: ""; position: absolute; inset: 0; border-radius: 16px; pointer-events: none;
    border: 1px solid rgba(var(--c2), 0.62);
    box-shadow: inset 0 0 2px rgba(255, 220, 180, 0.9), inset 0 0 20px rgba(var(--c), 0.16);
  }
  /* A redder copy of the frame that fades in as the agent struggles. */
  .frame.hot { --c: 255, 52, 40; --c2: 255, 96, 78; opacity: 0; transition: opacity 0.9s ease; animation: glowHot 2.4s ease-in-out infinite; }
  body[data-difficulty="2"] .frame.hot { opacity: 0.5; }
  body[data-difficulty="3"] .frame.hot { opacity: 0.92; animation-duration: 1.4s; }
  @keyframes glow {
    50% { opacity: 0.86; filter: brightness(1.12); }
  }
  @keyframes glowHot {
    50% { filter: brightness(1.25); }
  }

  /* The agent: a pearl head with a dark glass screen, LED eyes and two pods for ears. */
  .mascot {
    position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
    display: none; flex-direction: column; align-items: center; gap: 0;
    pointer-events: none; user-select: none;
  }
  body.primary .mascot { display: flex; }
  .mascot-svg { display: block; width: 180px; height: 124px; overflow: visible; }
  .halo { animation: halo 3.6s ease-in-out infinite; transform-origin: 90px 70px; }
  @keyframes halo { 50% { transform: scale(1.07); opacity: 0.72; } }

  .rig { transform-origin: 90px 108px; }
  .pop { transform-origin: 90px 108px; }
  .pop.react { animation: pop 0.42s cubic-bezier(0.3, 1.6, 0.5, 1); }
  @keyframes pop { 0% { transform: scale(0.88, 0.9); } 60% { transform: scale(1.05, 1.04); } 100% { transform: scale(1, 1); } }
  .head { transform-origin: 90px 72px; }
  #g-led stop { transition: stop-color 0.35s ease; }

  /* Ears: white pods that lift, tilt, drop and wag; the ring on each one glows and spins. */
  .ear { transition: rotate 0.5s cubic-bezier(0.3, 1.5, 0.5, 1), translate 0.5s cubic-bezier(0.3, 1.5, 0.5, 1); }
  .ear-l { transform-origin: 52px 84px; rotate: calc(var(--ear-rot-l) * -1); translate: 0 var(--ear-dy-l); }
  .ear-r { transform-origin: 128px 84px; rotate: var(--ear-rot-r); translate: 0 var(--ear-dy-r); }
  .ear-l .ear-in { transform-origin: 52px 84px; animation: earIdleL 4.6s ease-in-out infinite; }
  .ear-r .ear-in { transform-origin: 128px 84px; animation: earIdleR 4.6s ease-in-out infinite; }
  @keyframes earIdleL { 0%, 100% { transform: rotate(3deg); } 50% { transform: rotate(-6deg); } }
  @keyframes earIdleR { 0%, 100% { transform: rotate(-3deg); } 50% { transform: rotate(6deg); } }
  @keyframes earWagL { from { transform: rotate(-10deg); } to { transform: rotate(5deg); } }
  @keyframes earWagR { from { transform: rotate(10deg); } to { transform: rotate(-5deg); } }
  @keyframes earShiverL { 0%, 100% { transform: rotate(0deg); } 25% { transform: rotate(-2.2deg); } 75% { transform: rotate(2.2deg); } }
  @keyframes earShiverR { 0%, 100% { transform: rotate(0deg); } 25% { transform: rotate(2.2deg); } 75% { transform: rotate(-2.2deg); } }
  @keyframes earFlick { 0%, 78%, 100% { transform: rotate(0deg); } 84% { transform: rotate(11deg); } 90% { transform: rotate(-3deg); } 95% { transform: rotate(4deg); } }
  @keyframes earWave { from { transform: rotate(-12deg); } to { transform: rotate(12deg); } }
  body[data-mood="happy"] .ear-l .ear-in { animation: earWagL 0.42s ease-in-out infinite alternate; }
  body[data-mood="happy"] .ear-r .ear-in { animation: earWagR 0.42s ease-in-out infinite alternate; }
  body[data-mood="struggling"] .ear-l .ear-in, body[data-mood="worried"] .ear-l .ear-in, body[data-mood="overwhelmed"] .ear-l .ear-in { animation: earShiverL 0.13s linear infinite; }
  body[data-mood="struggling"] .ear-r .ear-in, body[data-mood="worried"] .ear-r .ear-in, body[data-mood="overwhelmed"] .ear-r .ear-in { animation: earShiverR 0.13s linear infinite; }
  body[data-mood="curious"] .ear-r .ear-in { animation: earFlick 3s ease-in-out infinite; }
  body[data-mood="asking"] .ear-r .ear-in { animation: earWave 0.5s ease-in-out infinite alternate; }
  body[data-mood="sleepy"] .ear-in, body[data-mood="sad"] .ear-in { animation: none; }
  .ring { filter: drop-shadow(0 0 2.5px var(--ring)); }
  .ring-spin { transform-origin: 0 0; animation: spin var(--ring-speed, 3s) linear infinite; transition: stroke 0.35s ease; }
  .ring-core { transform-origin: 0 0; animation: ringCore var(--ring-speed, 3s) ease-in-out infinite; }
  @keyframes ringCore { 50% { transform: scale(0.55); opacity: 0.7; } }

  /* Screen: LED eyes (their glow is a CSS filter) and the optional glowing mouth. */
  .eyes { filter: drop-shadow(0 0 2.5px rgba(var(--led-glow), 0.95)) drop-shadow(0 0 7px rgba(var(--led-glow), 0.55)); }
  .mouth { filter: drop-shadow(0 0 3px rgba(var(--led-glow), 0.9)); }
  .cheek { opacity: var(--cheek, 0.35); transition: opacity 0.4s ease; }
  .ev, .mv, .x, .glitch { display: none; }
  .eye-wrap { transform-origin: 0 0; transition: transform 0.11s ease; }
  .eyes.blink .eye-wrap { transform: scaleY(0.07); }
  .eyes.wink .slot-r .eye-wrap { transform: scaleY(0.07); }
  .gaze { transform: translate(var(--gaze-x, 0px), var(--gaze-y, 0px)); }
  .excited .gaze { scale: 1.1; }
  .excited .mouth { scale: 1.1; }
  .led-pose { transition: rotate 0.3s ease, translate 0.3s ease; }
  .led-pose-l { rotate: var(--rot-l, 0deg); translate: 0 var(--dy-l, 0px); }
  .led-pose-r { rotate: var(--rot-r, 0deg); translate: 0 var(--dy-r, 0px); }
  .led, .glint { transition: width 0.3s ease, height 0.3s ease, x 0.3s ease, y 0.3s ease, rx 0.3s ease, ry 0.3s ease; }
  .led-l { width: var(--w-l, 14px); height: var(--h-l, 17px); x: calc(var(--w-l, 14px) / -2); y: calc(var(--h-l, 17px) / -2); rx: var(--r-l, 6.5px); ry: var(--r-l, 6.5px); }
  .led-r { width: var(--w-r, 14px); height: var(--h-r, 17px); x: calc(var(--w-r, 14px) / -2); y: calc(var(--h-r, 17px) / -2); rx: var(--r-r, 6.5px); ry: var(--r-r, 6.5px); }
  .glint-l { width: calc(var(--w-l, 14px) * 0.34); height: calc(var(--h-l, 17px) * 0.2); x: calc(var(--w-l, 14px) * -0.33); y: calc(var(--h-l, 17px) * -0.37); rx: 1.6px; ry: 1.6px; }
  .glint-r { width: calc(var(--w-r, 14px) * 0.34); height: calc(var(--h-r, 17px) * 0.2); x: calc(var(--w-r, 14px) * -0.33); y: calc(var(--h-r, 17px) * -0.37); rx: 1.6px; ry: 1.6px; }
  .spin { animation: spin 1.1s linear infinite; }
  .ev-star .pulse { animation: starPulse 0.7s ease-in-out infinite; }
  @keyframes starPulse { 50% { transform: scale(1.18) rotate(8deg); } }
  @keyframes spin { to { transform: rotate(360deg); } }
  body[data-mood="working"] .eye-wrap { animation: ledType 0.7s ease-in-out infinite; }
  @keyframes ledType { 50% { scale: 1.04 0.86; } }
  body[data-mood="sleepy"] .eye-wrap { animation: ledSleep 5s ease-in-out infinite; }
  @keyframes ledSleep { 0%, 100% { scale: 1 1; } 42%, 62% { scale: 1 0.4; } 68% { scale: 1 1.2; } }
  body[data-mood="struggling"] .eyes { animation: eyeShake 0.16s linear infinite; }
  body[data-mood="worried"] .eyes { animation: eyeShake 0.1s linear infinite; }
  @keyframes eyeShake { 0%, 100% { transform: translate(0, 0); } 25% { transform: translate(-0.9px, 0.4px); } 50% { transform: translate(0.9px, -0.4px); } 75% { transform: translate(-0.5px, 0.3px); } }
  body[data-mood="overwhelmed"] .eyes { animation: glitchX 1.1s steps(1) infinite; }
  @keyframes glitchX { 0%, 100% { transform: translate(0, 0); } 8% { transform: translate(-3px, 0); } 10% { transform: translate(3px, 1px); } 12% { transform: translate(0, 0); } 55% { transform: translate(2px, 0); } 57% { transform: translate(0, 0); } }
  .scanbar { animation: scan 1.6s linear infinite; }
  @keyframes scan { from { transform: translateY(-8px); } to { transform: translateY(70px); } }
${variantCss()}

  /* Extras: little props that explain the mood. */
  .x text { font-family: "Segoe UI", system-ui, sans-serif; }
  .drip { animation: drip 1.7s ease-in infinite; }
  @keyframes drip { 0% { transform: translateY(-3px) scale(0.5); opacity: 0; } 25% { transform: translateY(0) scale(1); opacity: 1; } 75% { opacity: 1; } 100% { transform: translateY(15px) scale(0.9); opacity: 0; } }
  .weep { animation: weep 2.2s ease-in infinite; }
  @keyframes weep { 0% { transform: translateY(-4px) scale(0.5); opacity: 0; } 20% { transform: translateY(0) scale(1); opacity: 1; } 80% { opacity: 1; } 100% { transform: translateY(14px) scale(0.95); opacity: 0; } }
  .bubble { transform-origin: -6px 12px; animation: bubble 1.4s ease-in-out infinite; }
  .bubble.alarm { animation: alarm 0.36s ease-in-out infinite; }
  @keyframes bubble { 0%, 100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-3px) scale(1.07); } }
  @keyframes alarm { 0%, 100% { transform: rotate(-5deg) scale(1.04); } 50% { transform: rotate(5deg) scale(1.1); } }
  .z { transform-box: fill-box; transform-origin: center; animation: zfloat 3.2s ease-in-out infinite; }
  .z2 { animation-delay: 0.7s; } .z3 { animation-delay: 1.4s; }
  @keyframes zfloat { 0% { transform: translate(-4px, 7px) scale(0.55); opacity: 0; } 30% { opacity: 1; } 75% { opacity: 1; } 100% { transform: translate(6px, -9px) scale(1.12); opacity: 0; } }
  .thought { animation: thought 2.4s ease-in-out infinite; }
  @keyframes thought { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
  .td { transform-box: fill-box; transform-origin: center; animation: dotJump 1.2s ease-in-out infinite; }
  .td2 { animation-delay: 0.18s; } .td3 { animation-delay: 0.36s; }
  @keyframes dotJump { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-3.6px); } }
  .gear { animation: spin var(--gear-speed, 3s) linear infinite; }
  .gear-b { animation-duration: calc(var(--gear-speed, 3s) * 0.64); animation-direction: reverse; }
  .orb { transform: rotate(var(--a, 0deg)); animation: orb 2.4s linear infinite; }
  .orb-c { transform: rotate(calc(var(--a, 0deg) * -1)); animation: orbCounter 2.4s linear infinite; }
  @keyframes orb { to { transform: rotate(calc(var(--a, 0deg) + 360deg)); } }
  @keyframes orbCounter { to { transform: rotate(calc(var(--a, 0deg) * -1 - 360deg)); } }
  .puff { transform-box: fill-box; transform-origin: center; animation: puff 2.1s ease-out infinite; }
  .puff.p2 { animation-delay: 0.7s; } .puff.p3 { animation-delay: 1.3s; }
  @keyframes puff { 0% { transform: translate(0, 4px) scale(0.5); opacity: 0; } 25% { opacity: 0.85; } 100% { transform: translate(0, -17px) scale(1.5); opacity: 0; } }
  .cf { animation: confetti 1.9s ease-in infinite; }
  @keyframes confetti { 0% { transform: translateY(-6px) rotate(0deg) scale(0.4); opacity: 0; } 15% { opacity: 1; transform: translateY(-2px) rotate(60deg) scale(1); } 85% { opacity: 1; } 100% { transform: translateY(14px) rotate(330deg) scale(1); opacity: 0; } }
  .sparkle { animation: twinkle 1.5s ease-in-out infinite; }
  @keyframes twinkle { 0%, 100% { transform: scale(0.35) rotate(0deg); opacity: 0.4; } 50% { transform: scale(1.15) rotate(35deg); opacity: 1; } }
  .puffcloud { animation: exhale 2.6s ease-out infinite; }
  @keyframes exhale { 0% { transform: translate(-3px, 0) scale(0.4); opacity: 0; } 30% { opacity: 1; } 100% { transform: translate(11px, 3px) scale(1.15); opacity: 0; } }

  /* One body animation per mood. */
${KEYFRAMES}
${moodCss()}

  .tag {
    display: flex; align-items: center; gap: 7px; padding: 7px 12px; border-radius: 999px; margin-top: 2px;
    background: rgba(26, 21, 18, 0.90); border: 1px solid rgba(255, 122, 26, 0.34);
    color: #ffe4cc; font-size: 12px; line-height: 1; letter-spacing: 0.01em; white-space: nowrap;
    box-shadow: 0 8px 26px rgba(0, 0, 0, 0.36); backdrop-filter: blur(10px);
    transition: border-color 0.4s ease;
  }
  body[data-difficulty="2"] .tag { border-color: rgba(255, 106, 58, 0.55); }
  body[data-difficulty="3"] .tag { border-color: rgba(255, 59, 59, 0.7); }
  .tag .dot {
    flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--dot, #ff7a1a);
    box-shadow: 0 0 0 4px rgba(255, 122, 26, 0.16); animation: pulse 1.5s ease-in-out infinite;
    transition: background-color 0.3s ease;
  }
  body[data-difficulty="3"] .tag .dot { animation-duration: 0.6s; }
  @keyframes pulse { 50% { transform: scale(0.68); opacity: 0.6; } }

  /* Munim's lavender agent pointer, 112x112 with its hotspot at the center. */
  .agent-cursor {
    position: absolute; left: 0; top: 0; width: 112px; height: 112px;
    margin-left: -56px; margin-top: -56px; opacity: 0; pointer-events: none; z-index: 20;
    transform: translate3d(-300px, -300px, 0);
    transition: transform 0.46s cubic-bezier(0.2, 1.35, 0.32, 1), opacity 0.18s ease;
    will-change: transform, opacity;
  }
  .agent-cursor.visible { opacity: 1; }
  .agent-cursor img {
    display: block; width: 100%; height: 100%;
    filter: drop-shadow(0 8px 14px rgba(20, 10, 40, 0.28));
    animation: cursorFloat 2.8s ease-in-out infinite;
  }
  .agent-cursor.press img { animation: cursorPress 0.22s ease-out; }
  @keyframes cursorFloat { 50% { transform: translateY(-2px) scale(1.025); } }
  @keyframes cursorPress {
    0% { transform: scale(1); }
    35% { transform: scale(0.82); }
    100% { transform: scale(1); }
  }

  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body class="paused${primary ? ' primary' : ''}" data-mood="calm" data-difficulty="0">
  <div class="frame"></div>
  <div class="frame hot"></div>
  <div class="mascot" aria-hidden="true">
    ${MASCOT_SVG}
    <div class="tag"><span class="dot"></span><span class="tag-text">${DEFAULT_LABEL}</span></div>
  </div>
  <div class="agent-cursor" aria-hidden="true"><img src="${CURSOR_ARROW_DATA_URL}" alt=""></div>
  <script>
    (() => {
      const DEFAULT_LABEL = ${JSON.stringify(DEFAULT_LABEL)};
      const LOOKS = ${scriptLooks()};
      const BLINKABLE = { led: true };

      const body = document.body;
      const svg = document.querySelector('.mascot-svg');
      const head = document.querySelector('.head');
      const eyes = document.querySelector('.eyes');
      const pop = document.querySelector('.pop');
      const tagText = document.querySelector('.tag-text');
      const cursor = document.querySelector('.agent-cursor');
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      let look = LOOKS.calm;
      let eyeKind = look.eyes;
      let pointer = null;
      let pointerAt = 0;
      let gazeX = 0;
      let gazeY = 0;
      let targetX = 0;
      let targetY = 0;
      let nextWander = 0;
      let raf = 0;
      let blinkTimer = 0;
      let doubleBlinkTimer = 0;
      let excitedTimer = 0;
      let settleTimer = 0;
      let popTimer = 0;
      let placed = false;
      let pressTimer = null;
      let paused = true;

      function nowMs() {
        return performance.now();
      }

      /* The eyelid is a vertical squash of the LED eyes. */
      function blink() {
        if (reduced || !BLINKABLE[eyeKind]) return;
        eyes.classList.add('blink');
        setTimeout(() => eyes.classList.remove('blink'), 130);
      }

      function scheduleBlink() {
        clearTimeout(blinkTimer);
        const delay = 1900 + Math.random() * 4300;
        blinkTimer = setTimeout(() => {
          blink();
          if (Math.random() < 0.2) {
            clearTimeout(doubleBlinkTimer);
            doubleBlinkTimer = setTimeout(blink, 170 + Math.random() * 90);
          }
          if (Math.random() < 0.1 && eyeKind === 'led') {
            setTimeout(() => {
              eyes.classList.add('wink');
              setTimeout(() => eyes.classList.remove('wink'), 130);
            }, 520);
          }
          scheduleBlink();
        }, delay);
      }

      function pickWander(now) {
        if (now < nextWander) return;
        targetX = (Math.random() * 2 - 1) * 5.6;
        targetY = (Math.random() * 2 - 1) * 3.6;
        nextWander = now + 900 + Math.random() * 1500;
      }

      /* Each mood may pin the gaze (thinking looks up-left, asking looks down,
         waiting sweeps left and right); otherwise the eyes slide towards the
         agent pointer inside the screen. */
      function chooseTarget(now) {
        let k = 0.18;
        const mode = look.gaze;
        if (mode === 'up') {
          targetX = -4.6 + Math.sin(now / 900) * 0.6;
          targetY = -4;
        } else if (mode === 'down') {
          targetX = Math.sin(now / 1500) * 1.2;
          targetY = 3.6;
        } else if (mode === 'sweep') {
          targetX = Math.sin(now / 520) * 5.2;
          targetY = 0.4;
          k = 0.3;
        } else if (mode === 'read') {
          // like reading the screen: a steady left-right scan with a slow drift down the page
          targetX = Math.sin(now / 760) * 5;
          targetY = Math.sin(now / 2300) * 2.2;
          k = 0.22;
        } else if (mode === 'still') {
          targetX = 0;
          targetY = 0;
        } else if (pointer && now - pointerAt < 3200) {
          const rect = head.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const dx = pointer.x - cx;
          const dy = pointer.y - cy;
          const len = Math.hypot(dx, dy) || 1;
          targetX = (dx / len) * 5;
          targetY = (dy / len) * 3.6;
        } else {
          pickWander(now);
        }
        return k;
      }

      function applyGaze(now) {
        eyes.style.setProperty('--gaze-x', gazeX.toFixed(2) + 'px');
        eyes.style.setProperty('--gaze-y', gazeY.toFixed(2) + 'px');
        const breathe = 1 + Math.sin(now / 1100) * 0.03;
        head.style.transform = 'rotate(' + (gazeX * 0.45).toFixed(2) + 'deg) scale(' + breathe.toFixed(4) + ')';
      }

      function aim(now) {
        const k = chooseTarget(now);
        gazeX += (targetX - gazeX) * k;
        gazeY += (targetY - gazeY) * k;
        applyGaze(now);
      }

      /* With reduced motion nothing animates, but the pinned gaze still shows the mood. */
      function snapGaze() {
        if (!reduced) return;
        chooseTarget(0);
        gazeX = look.gaze === 'free' ? 0 : targetX;
        gazeY = look.gaze === 'free' ? 0 : targetY;
        applyGaze(0);
      }

      function frame(now) {
        if (paused) return;
        aim(now);
        raf = requestAnimationFrame(frame);
      }

      function start() {
        if (reduced) {
          document.body.classList.remove('paused');
          return;
        }
        if (!paused) return;
        paused = false;
        document.body.classList.remove('paused');
        raf = requestAnimationFrame(frame);
        scheduleBlink();
      }

      function stop() {
        paused = true;
        document.body.classList.add('paused');
        cancelAnimationFrame(raf);
        clearTimeout(blinkTimer);
        clearTimeout(doubleBlinkTimer);
      }

      function react() {
        svg.classList.add('excited');
        clearTimeout(excitedTimer);
        excitedTimer = setTimeout(() => svg.classList.remove('excited'), 420);
        blink();
        setTimeout(blink, 180);
      }

      function setEyes(kind) {
        eyeKind = kind;
        svg.setAttribute('data-eyes', kind);
        if (!BLINKABLE[kind]) eyes.classList.remove('blink', 'wink');
      }

      /* A short squash-and-stretch whenever the mood changes. */
      function reactToChange() {
        if (reduced) return;
        pop.classList.remove('react');
        void pop.getBoundingClientRect();
        pop.classList.add('react');
        clearTimeout(popTimer);
        popTimer = setTimeout(() => pop.classList.remove('react'), 460);
      }

      /* { mood, difficulty: 0..3, label } from the main process. */
      window.setAgentMood = (state) => {
        if (!state || typeof state !== 'object') return;
        const next = LOOKS[state.mood];
        if (!next) return;
        const changed = body.getAttribute('data-mood') !== state.mood;
        const difficulty = Math.max(0, Math.min(3, Math.round(Number(state.difficulty) || 0)));
        body.setAttribute('data-mood', state.mood);
        body.setAttribute('data-difficulty', String(difficulty));
        look = next;
        setEyes(next.eyes);
        svg.setAttribute('data-mouth', next.mouth);
        svg.setAttribute('data-extras', next.extras);
        const label = typeof state.label === 'string' && state.label.trim() ? state.label.trim() : DEFAULT_LABEL;
        tagText.textContent = label.length > 80 ? label.slice(0, 79) + '…' : label;
        clearTimeout(settleTimer);
        // Celebration: a burst of star eyes, then the happy ^ ^.
        if (state.mood === 'happy' && !reduced) {
          setEyes('star');
          settleTimer = setTimeout(() => setEyes('happy'), 1000);
        }
        if (changed) reactToChange();
        snapGaze();
      };

      window.setAgentCursor = (x, y, press) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        start();
        pointer = { x, y };
        pointerAt = nowMs();
        if (!placed) {
          cursor.style.transition = 'opacity 0.18s ease';
          cursor.style.transform = 'translate3d(' + x + 'px, ' + y + 'px, 0)';
          requestAnimationFrame(() => { cursor.style.transition = ''; });
          placed = true;
        } else {
          cursor.style.transform = 'translate3d(' + x + 'px, ' + y + 'px, 0)';
        }
        cursor.classList.add('visible');
        if (press) {
          cursor.classList.add('press');
          clearTimeout(pressTimer);
          pressTimer = setTimeout(() => cursor.classList.remove('press'), 230);
          react();
        }
      };

      window.hideAgentCursor = () => {
        cursor.classList.remove('visible');
        cursor.classList.remove('press');
        pointer = null;
      };

      window.resumeAgentFace = start;
      window.pauseAgentFace = stop;

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) stop();
        else start();
      });
    })();
  </script>
</body>
</html>`
}
