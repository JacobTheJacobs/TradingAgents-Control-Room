/**
 * Agent sprite generators
 * Creates detailed agent sprites with all animation frames
 */
import { createSheet, roundRect } from './helpers'
import { getPalette } from './palette'

function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function hexToRgb(hexColor) {
  const normalized = String(hexColor || '').replace('#', '').trim()
  const six = normalized.length === 3
    ? normalized.split('').map((ch) => ch + ch).join('')
    : normalized
  if (!/^[0-9a-fA-F]{6}$/.test(six)) {
    return { r: 128, g: 128, b: 128 }
  }
  return {
    r: parseInt(six.slice(0, 2), 16),
    g: parseInt(six.slice(2, 4), 16),
    b: parseInt(six.slice(4, 6), 16)
  }
}

function rgbToHex({ r, g, b }) {
  return `#${[clampChannel(r), clampChannel(g), clampChannel(b)]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`
}

function shadeColor(hexColor, amount) {
  const rgb = hexToRgb(hexColor)
  const normalized = Math.max(-1, Math.min(1, amount / 100))
  const shifted = normalized >= 0
    ? {
        r: rgb.r + (255 - rgb.r) * normalized,
        g: rgb.g + (255 - rgb.g) * normalized,
        b: rgb.b + (255 - rgb.b) * normalized
      }
    : {
        r: rgb.r * (1 + normalized),
        g: rgb.g * (1 + normalized),
        b: rgb.b * (1 + normalized)
      }
  return rgbToHex(shifted)
}

function createAccentRamp(baseColor) {
  return {
    base: baseColor,
    dark: shadeColor(baseColor, -34),
    deep: shadeColor(baseColor, -48),
    light: shadeColor(baseColor, 24),
    muted: shadeColor(baseColor, -14),
    glow: shadeColor(baseColor, 42)
  }
}

function createPainter(ctx, ox, oy) {
  const r = (color, x, y, w, h) => {
    ctx.fillStyle = color
    ctx.fillRect(ox + x, oy + y, w, h)
  }
  const p = (color, x, y) => r(color, x, y, 1, 1)
  return { r, p }
}

function createAgentPalette(agent, accent, overrides = {}) {
  const suitBase = overrides.suit || agent.suit
  const tieBase = overrides.tie || accent.base
  const hairBase = overrides.hair || accent.base
  const eyeColor = overrides.eye || '#050805'
  const shoeBase = overrides.shoes || agent.shoes || '#1f1f1f'
  return {
    skin: overrides.skin || agent.skin,
    skinShadow: overrides.skinShadow || agent.skinShadow || shadeColor(agent.skin, -22),
    hair: hairBase,
    hairShadow: overrides.hairShadow || shadeColor(hairBase, -34),
    hairLight: overrides.hairLight || shadeColor(hairBase, 24),
    suit: suitBase,
    suitShadow: overrides.suitShadow || shadeColor(suitBase, -22),
    suitDeepShadow: overrides.suitDeepShadow || shadeColor(suitBase, -32),
    suitRim: overrides.suitRim || shadeColor(suitBase, 16),
    tie: tieBase,
    tieDark: overrides.tieDark || shadeColor(tieBase, -34),
    tieLight: overrides.tieLight || shadeColor(tieBase, 28),
    shirt: overrides.shirt || agent.shirt,
    shirtShadow: overrides.shirtShadow || shadeColor(overrides.shirt || agent.shirt, -22),
    shirtLight: overrides.shirtLight || shadeColor(overrides.shirt || agent.shirt, 12),
    glassFrame: overrides.glassFrame || agent.glassFrame || '#22303a',
    glassGlint: overrides.glassGlint || agent.glassGlint || '#f3fbff',
    blush: overrides.blush || agent.blush || shadeColor(overrides.skin || agent.skin, 8),
    mouth: overrides.mouth || agent.mouth || '#3e1f1f',
    shoes: shoeBase,
    shoesLight: overrides.shoesLight || shadeColor(shoeBase, 16),
    outline: overrides.outline || shadeColor(suitBase, -58),
    outlineSoft: overrides.outlineSoft || shadeColor(suitBase, -42),
    eye: eyeColor
  }
}

function drawStandingLegs(paint, C, { cx, ly, isSide, isWalking, cycle, legWidth = 4, shoeWidth = 4, stride = 3 }) {
  const { r } = paint
  if (isSide) {
    let leftX = cx - Math.floor(legWidth / 2)
    let rightX = leftX
    if (isWalking) {
      if (cycle === 1) {
        leftX -= stride
        rightX += 2
      } else if (cycle === 3) {
        leftX += 2
        rightX -= stride
      }
    }
    r(C.suitShadow, rightX + 2, ly, legWidth, 6)
    r(C.shoes, rightX + 2, ly + 5, shoeWidth, 2)
    if (C.shoesLight) r(C.shoesLight, rightX + 2, ly + 5, Math.max(1, shoeWidth - 1), 1)
    r(C.suit, leftX, ly, legWidth, 6)
    if (C.suitRim) r(C.suitRim, leftX, ly, legWidth, 1)
    if (C.outlineSoft) r(C.outlineSoft, leftX, ly + 1, 1, 5)
    r(C.shoes, leftX, ly + 5, shoeWidth, 2)
    if (C.shoesLight) r(C.shoesLight, leftX, ly + 5, Math.max(1, shoeWidth - 1), 1)
    return
  }
  const leftLegX = cx - (legWidth + 1)
  const rightLegX = cx + 1
  r(C.suit, leftLegX, ly, legWidth, 6)
  r(C.suit, rightLegX, ly, legWidth, 6)
  if (C.suitRim) {
    r(C.suitRim, leftLegX, ly, legWidth, 1)
    r(C.suitRim, rightLegX, ly, legWidth, 1)
  }
  r(C.shoes, leftLegX, ly + 5, shoeWidth, 2)
  r(C.shoes, rightLegX, ly + 5, shoeWidth, 2)
  if (C.shoesLight) {
    r(C.shoesLight, leftLegX, ly + 5, Math.max(1, shoeWidth - 1), 1)
    r(C.shoesLight, rightLegX, ly + 5, Math.max(1, shoeWidth - 1), 1)
  }
}

function drawBusinessTorso(paint, C, { cx, ty, isBack, isSide, torsoW, torsoH, shirtW = 4, tieW = 2 }) {
  const { r } = paint
  const x = cx - Math.floor(torsoW / 2)
  if (isBack) {
    r(C.suit, x, ty, torsoW, torsoH)
    if (C.outlineSoft) {
      r(C.outlineSoft, x, ty + 1, 1, torsoH - 1)
      r(C.outlineSoft, x + torsoW - 1, ty + 1, 1, torsoH - 1)
    }
    r(C.suitShadow, x + 1, ty + 2, Math.max(2, torsoW - 2), Math.max(2, torsoH - 2))
    r(C.suitDeepShadow || C.suitShadow, x + 2, ty + 4, Math.max(2, torsoW - 4), Math.max(2, torsoH - 5))
    if (C.suitRim) r(C.suitRim, x, ty, torsoW, 1)
    return
  }
  if (isSide) {
    r(C.suitShadow, x + 4, ty + 1, torsoW - 6, torsoH - 1)
    r(C.suit, x + 1, ty, torsoW - 4, torsoH)
    if (C.suitRim) r(C.suitRim, x + 1, ty, torsoW - 4, 1)
    return
  }
  r(C.suit, x, ty, torsoW, torsoH)
  if (C.outlineSoft) {
    r(C.outlineSoft, x, ty + 1, 1, torsoH - 1)
    r(C.outlineSoft, x + torsoW - 1, ty + 1, 1, torsoH - 1)
  }
  r(C.suitShadow, x + 1, ty + 3, torsoW - 2, Math.max(3, torsoH - 5))
  if (C.suitRim) r(C.suitRim, x, ty, torsoW, 1)
  const shirtX = cx - Math.floor(shirtW / 2)
  r(C.shirt, shirtX, ty, shirtW, torsoH - 2)
  if (torsoW >= 12) {
    r(C.suit, shirtX - 3, ty + 1, 3, Math.max(2, torsoH - 4))
    r(C.suit, shirtX + shirtW, ty + 1, 3, Math.max(2, torsoH - 4))
    if (C.suitRim) {
      r(C.suitRim, shirtX - 2, ty + 1, 1, Math.max(2, torsoH - 5))
      r(C.suitRim, shirtX + shirtW + 1, ty + 1, 1, Math.max(2, torsoH - 5))
    }
    // Lapel cut to make the suit read at floor scale.
    r(C.shirt, shirtX - 1, ty + 1, 1, 3)
    r(C.shirt, shirtX + shirtW, ty + 1, 1, 3)
  }
  if (C.shirtLight) r(C.shirtLight, shirtX, ty, shirtW, 1)
  if (C.shirtShadow) r(C.shirtShadow, shirtX, ty + 3, shirtW, 2)
  const tieX = cx - Math.floor(tieW / 2)
  r(C.tie, tieX, ty + 1, tieW, torsoH - 3)
  if (tieW >= 3) r(C.tieLight, tieX, ty + 1, tieW - 1, 1)
  if (C.tieDark) r(C.tieDark, tieX, ty + 4, tieW, Math.max(2, torsoH - 7))
  if (C.tieLight && tieW > 1) r(C.tieLight, tieX, ty + 1, 1, torsoH - 4)
}

function drawBackHead(paint, C, { hx, hy, hW, hH }) {
  const { r } = paint
  if (C.outline) {
    r(C.outline, hx, hy + 3, 1, hH - 4)
    r(C.outline, hx + hW - 1, hy + 3, 1, hH - 4)
  }
  r(C.skin, hx + 2, hy, hW - 4, hH - 1)
  r(C.skinShadow, hx + 3, hy + 9, hW - 6, hH - 10)
  r(C.skin, hx + 1, hy + 2, 1, hH - 4)
  r(C.skin, hx + hW - 2, hy + 2, 1, hH - 4)
  r(C.hair, hx, hy + 4, hW, hH - 4)
  r(C.hair, hx + 2, hy, hW - 4, 8)
  r(C.hairShadow, hx + 1, hy + 10, hW - 2, Math.max(2, hH - 10))
  if (C.hairLight) r(C.hairLight, hx + 3, hy + 1, hW - 8, 2)
}

function drawFrontHeadShell(paint, C, { hx, hy, hW, hH }) {
  const { r } = paint
  if (C.outline) {
    r(C.outline, hx, hy + 2, 1, hH - 3)
    r(C.outline, hx + hW - 1, hy + 2, 1, hH - 3)
  }
  r(C.skin, hx + 2, hy, hW - 4, hH)
  r(C.skin, hx + 1, hy + 2, 1, hH - 4)
  r(C.skin, hx + hW - 2, hy + 2, 1, hH - 4)
  r(C.skinShadow, hx + 3, hy + 11, hW - 6, hH - 13)
  r(C.hair, hx + 1, hy + 3, 4, 10)
  r(C.hair, hx + hW - 5, hy + 3, 4, 10)
  r(C.hair, hx + 1, hy, hW - 2, 4)
  if (C.hairLight) {
    r(C.hairLight, hx + 3, hy + 1, 7, 1)
    r(C.hairLight, hx + hW - 10, hy + 1, 7, 1)
  }
}

function drawSideHeadShell(paint, C, { hx, hy, hW, hH }) {
  const { r } = paint
  if (C.outline) r(C.outline, hx, hy + 2, 1, hH - 2)
  r(C.skin, hx, hy, hW, hH)
  r(C.skinShadow, hx + Math.floor(hW / 2), hy + 8, Math.floor(hW / 2), hH - 9)
  r(C.hair, hx, hy + 4, Math.floor(hW / 2) + 1, hH - 4)
  if (C.hairLight) r(C.hairLight, hx + 1, hy + 4, Math.floor(hW / 2) - 1, 1)
}

function drawFaceDefault(paint, C, { hx, gy, hW, cx, glassW = 8, glassH = 6 }) {
  const { r, p } = paint
  r(C.glassFrame, hx + 2, gy, glassW, glassH)
  r(C.skin, hx + 4, gy + 2, glassW - 4, glassH - 4)
  r(C.eye || '#000', hx + 5, gy + 3, 2, 2)
  r(C.eye || '#000', hx + 5, gy + 5, 1, 1)
  p(C.glassGlint, hx + 4, gy + 2)
  if (C.outlineSoft) r(C.outlineSoft, hx + 2, gy, glassW, 1)

  r(C.glassFrame, hx + hW - glassW - 2, gy, glassW, glassH)
  r(C.skin, hx + hW - glassW, gy + 2, glassW - 4, glassH - 4)
  r(C.eye || '#000', hx + hW - glassW + 1, gy + 3, 2, 2)
  r(C.eye || '#000', hx + hW - glassW + 2, gy + 5, 1, 1)
  p(C.glassGlint, hx + hW - glassW, gy + 2)
  if (C.outlineSoft) r(C.outlineSoft, hx + hW - glassW - 2, gy, glassW, 1)

  r(C.glassFrame, cx - 2, gy + 3, 4, 2)
  r(C.mouth, cx - 3, gy + 11, 6, 1)
  r(C.blush, hx + 2, gy + 7, 4, 3)
  r(C.blush, hx + hW - 6, gy + 7, 4, 3)
}

function getReadabilityProfile(row) {
  const isSide = row === 1 || row === 7 || row === 8
  const isSeated = row === 4 || row === 5 || row === 6
  return {
    headW: isSide ? 26 : 28,
    headH: isSeated ? 23 : 22,
    torsoW: isSide ? 12 : 16,
    torsoH: isSeated ? 13 : 12,
    shirtW: isSeated ? 6 : 5,
    tieW: 3,
    legWidth: 4,
    shoeWidth: 5,
    stride: row <= 2 ? 4 : 3,
    headLift: row === 3 ? -1 : row === 4 ? -5 : row === 5 ? -3 : row === 6 ? -5 : row === 8 ? -1 : 0,
    torsoLift: row === 3 ? -1 : row === 4 ? -3 : row === 6 ? -2 : 0,
    shoulderW: isSide ? 11 : 20,
    shoulderY: row === 4 || row === 6 ? 1 : 0,
    armWidth: isSide ? 4 : 4,
    armLength: row === 0 || row === 3 ? 7 : 6,
    glassW: isSide ? 9 : 10,
    glassH: 7
  }
}

function drawShoulderSilhouette(paint, C, { cx, ty, width = 18, isSide = false, isBack = false, yOffset = 0 }) {
  const { r } = paint
  if (isSide) {
    r(C.suit, cx - 4, ty + yOffset, 2, 2)
    r(C.suit, cx + 2, ty + yOffset, 2, 2)
    return
  }
  const shoulderX = cx - Math.floor(width / 2)
  if (isBack) {
    r(C.suitShadow, shoulderX + 1, ty + yOffset + 1, width - 2, 2)
  }
  r(C.suit, shoulderX, ty + yOffset, width, 2)
  if (C.suitRim) r(C.suitRim, shoulderX + 1, ty + yOffset, Math.max(2, width - 2), 1)
}

/**
 * Create detailed agent sprite with all animations
 * @param {Phaser.Scene} scene - The Phaser scene
 * @param {string} key - Texture key for the agent
 * @param {string} agentColor - Primary color for the agent
 */
export function createDetailedAgent(scene, key, agentColor, isEvening = false) {
  const palette = getPalette(isEvening)
  const { agent } = palette
  const w = 32, h = 48, cols = 4
  const rows = 45
  const canvas = document.createElement('canvas')
  canvas.width = w * cols
  canvas.height = h * rows
  const ctx = canvas.getContext('2d')
  const accent = createAccentRamp(agentColor)

  const C = createAgentPalette(agent, accent, { eye: '#050805' })

  const drawAgent = (ox, oy, row, cycle) => {
    const paint = createPainter(ctx, ox, oy)
    const { r, p } = paint
    const profile = getReadabilityProfile(row)

    // Row 6: Sitting back view (typing at desk)
    if (row === 6) {
      const cx = 16
      const hW = profile.headW
      const hH = profile.headH
      const sitOffset = 4
      const ty = 30 + sitOffset
      drawShoulderSilhouette(paint, C, { cx, ty, width: 18, yOffset: 1 })
      drawBusinessTorso(paint, C, {
        cx,
        ty,
        isBack: true,
        isSide: false,
        torsoW: 14,
        torsoH: 12,
        shirtW: 5,
        tieW: 2
      })
      if (cycle === 0) { r(C.suit, cx - 9, ty + 2, 4, 6); r(C.suit, cx + 5, ty + 2, 4, 6) }
      else if (cycle === 1) { r(C.suit, cx - 11, ty + 1, 6, 4); r(C.suit, cx + 5, ty + 2, 4, 6) }
      else if (cycle === 2) { r(C.suit, cx - 9, ty + 2, 4, 6); r(C.suit, cx + 5, ty + 1, 6, 4) }
      else { r(C.suit, cx - 11, ty + 0, 6, 5); r(C.suit, cx + 5, ty + 0, 6, 5) }
      const headBob = (cycle === 3 || cycle === 1) ? 1 : 0
      const hx = cx - hW / 2
      const hy = ty - hH + 1 + headBob
      r(C.skin, hx + hW / 2 - 2, hy + hH - 2, 4, 4)
      drawBackHead(paint, C, { hx, hy, hW, hH })
      return
    }

    const isWalking = row <= 2
    const isBack = (row === 2)
    const isSide = (row === 1 || row === 8 || row === 7)
    const bounce = (isWalking && (cycle === 1 || cycle === 3)) ? -1 : 0
    const cx = 16
    let by = 44 + bounce
    if (row === 4) by += 2
    let jump = 0
    if (row === 12 && (cycle === 0 || cycle === 2)) jump = -6
    by += jump
    const ly = by - 6
    const ty = ly - 8 + profile.torsoLift
    const hW = profile.headW
    const hH = profile.headH

    // Removed generic drop shadow that lived under agents
    // r('rgba(0,0,0,0.2)', cx - 10, 41, 20, 3)

    // Legs / Knees
    if (row === 4) {
      r(C.suitShadow, cx - 5, ly, 4, 4); r(C.suitShadow, cx + 1, ly, 4, 4)
      r('#3E2723', cx - 7, ty + 6, 14, 10)
    } else if (row === 14) {
      // KNEES ON FLOOR (Hammering Whine)
      r(C.suitShadow, cx - 8, ly + 4, 6, 2)
      r(C.suitShadow, cx + 2, ly + 4, 6, 2)
    } else {
      drawStandingLegs(paint, C, {
        cx,
        ly,
        isSide,
        isWalking,
        cycle,
        legWidth: profile.legWidth,
        shoeWidth: profile.shoeWidth,
        stride: profile.stride
      })
    }

    // Body
    if (row === 14) {
      // HIDE BODY FOR ABSTRACT WHINE
    } else {
      drawShoulderSilhouette(paint, C, {
        cx,
        ty,
        width: profile.shoulderW,
        isSide,
        isBack,
        yOffset: profile.shoulderY
      })
      drawBusinessTorso(paint, C, {
        cx,
        ty,
        isBack,
        isSide,
        torsoW: profile.torsoW,
        torsoH: profile.torsoH,
        shirtW: profile.shirtW,
        tieW: profile.tieW
      })
    }

    // Arms (Default Logic)
    const isCustomMeme = row >= 20
    if (row !== 13 && row !== 14 && !isCustomMeme) {
      if (row === 0 || row === 3) {
        r(C.suit, cx - 10, ty + 1, profile.armWidth, profile.armLength); r(C.skin, cx - 10, ty + 8, 4, 3)
        r(C.suit, cx + 6, ty + 1, profile.armWidth, profile.armLength); r(C.skin, cx + 6, ty + 8, 4, 3)
      } else if (row === 1) {
        if (cycle === 1) r(C.suit, cx + 1, ty + 3, 4, 6)
        else if (cycle === 3) r(C.suit, cx - 6, ty + 3, 4, 6)
      } else if (row === 8) {
        r(C.suit, cx - 5, ty + 3, 3, 5)
        r(C.suit, cx + 4, ty + 2, 4, 6)
        r(C.skin, cx + 6, ty + 7, 3, 3)
      }
    }

    let hy = ty - hH + 4 + profile.headLift
    const headShakeX = (row === 13 && cycle >= 2) ? (cycle === 2 ? -1 : 1) : 0
    if (row === 13) hy += (cycle === 0 ? 2 : cycle === 1 ? 4 : 8)
    if (row === 14) hy += (cycle % 2 === 0 ? 11 : 10)

    const hx = cx - hW / 2 + headShakeX

    // Head Drawing
    if (isBack) {
      drawBackHead(paint, C, { hx, hy, hW, hH })
    } else if (isSide) {
      drawSideHeadShell(paint, C, { hx, hy, hW, hH })
      r(C.glassFrame, hx + hW / 2, hy + 8, 2, 6)
      r(C.glassFrame, hx, hy + 9, hW / 2, 2)
      const gy = hy + 8
      if (row === 8 && (cycle % 2 !== 0)) r(C.mouth, cx - 2, gy + 10, 4, 3)
      else r(C.mouth, cx - 2, gy + 10, 4, 1)
    } else {
      // Front face / Special rows
      if ((row === 13 && cycle >= 2) || row === 14) {
        if (row === 14) {
          // ABSTRACT WHINE HEAD - Centered and Elevated
          hy = ty - 8 // Raised higher
          const faceX = cx - 10 + headShakeX // More centered
          r(C.hair, faceX, hy, hW - 4, hH - 4)
          
          // VERTICAL TEAR STREAMS (90 degrees down)
          const tH1 = 14 + (cycle % 2) * 8
          const tH2 = 8 + ((cycle + 1) % 2) * 6
          
          // Left tears
          r('#60a5fa', faceX - 3, hy + 10, 2, tH1)
          r('#60a5fa', faceX - 6, hy + 14, 2, tH2)
          
          // Right tears
          r('#60a5fa', faceX + hW - 3, hy + 10, 2, tH1)
          r('#60a5fa', faceX + hW, hy + 14, 2, tH2)
          
          // Droplet highlights
          p('#FFF', faceX - 2, hy + 10 + tH1 - 1)
          p('#FFF', faceX + hW - 2, hy + 10 + tH1 - 1)
        } else {
          // Facepalm Head - Peak Despair (Hands & dark shadow removed)
          r(C.hair, hx + 1, hy, hW - 2, hH)
          r('#60a5fa', hx + hW - 2, hy + 6, 2, 4); p('#60a5fa', hx + hW - 1, hy + 10) // Sweat drop
        }
      } else {
        drawFrontHeadShell(paint, C, { hx, hy, hW, hH })
        const gy = hy + (row === 5 ? 7 : 8)
        const glassW = profile.glassW, glassH = profile.glassH
        let drawDefaultFace = true
        
        if (row === 8 && !isBack && !isSide) { // TALK
          if (cycle % 2 === 0) r(C.mouth, cx - 1, gy + 10, 2, 2)
          else r(C.mouth, cx - 2, gy + 11, 4, 1)
        } else if (row === 9 && !isBack && !isSide) { // POINT
          r(C.mouth, cx - 1, gy + 10, 2, 1)
        } else if (row === 12 && !isBack && !isSide) { // CHEER
          r(C.mouth, cx - 2, gy + 10, 4, 3); r('#fff', cx - 1, gy + 10, 2, 1) // smile teeth
          r(C.blush, hx + 2, gy + 6, 4, 3); r(C.blush, hx + hW - 6, gy + 6, 4, 3)
          if (cycle % 2 === 0) { p('#fff', hx + 4, gy + 1); p('#fff', hx + hW - 4, gy + 1) } // Glasses glint
        }

        if (row === 13 && cycle === 1) { // Sad eyes for facepalm swing
          r(C.glassFrame, hx + 2, gy + 2, glassW, 2)
          r(C.glassFrame, hx + hW - glassW - 2, gy + 2, glassW, 2)
          drawDefaultFace = false
        } else if (row === 20 && !isBack && !isSide) { // MARGIN CALL (Rekt) - Wojak shocked
          r('#fff', hx + 2, gy - 2, 10, 10); r('#fff', hx + hW - 12, gy - 2, 10, 10) // Huge eyes
          p('#000', hx + 6, gy + 3); p('#000', hx + hW - 8, gy + 3) // Tiny pupils
          r(C.mouth, cx - 4, gy + 10, 8, 4) // Open shocked mouth
          r('#000', cx - 2, gy + 11, 4, 2) // Dark inside mouth
          // Dark background shadow for dread
          r('rgba(0,0,0,0.5)', cx - 18, ty + 12, 36, 12)
          drawDefaultFace = false
        } else if (row === 22 && !isBack && !isSide) { // SMASH BUY - Laser eyes
          r('#16a34a', hx + 2, gy - 1, glassW, glassH); r('#16a34a', hx + hW - glassW - 2, gy - 1, glassW, glassH)
          r('#4ade80', hx + 4, gy + 1, 4, 2); r('#4ade80', hx + hW - 8, gy + 1, 4, 2) // Inner glow
          r(C.mouth, cx - 3, gy + 10, 6, 2) // Confident grin
          drawDefaultFace = false
        } else if (row === 23 && !isBack && !isSide) { // PANIC DUMP - Red panicked eyes
          r('#fee2e2', hx + 2, gy, glassW, glassH); r('#fee2e2', hx + hW - glassW - 2, gy, glassW, glassH)
          p('#000', hx + 5, gy + 3); p('#000', hx + hW - 6, gy + 3) // Panicked tiny pupils
          r(C.mouth, cx - 3, gy + 11, 6, 1) // Flat/sad mouth
          // Sweat drops flying
          const sY = gy - 4 + (cycle % 2) * 2
          r('#60a5fa', hx - 4, sY, 2, 3); r('#60a5fa', hx + hW + 2, sY + 2, 2, 3) 
          drawDefaultFace = false
        } else if (row === 21 && !isBack && !isSide) { // DIAMOND HANDS - Trembling shut eyes
          r(C.glassFrame, hx + 2, gy + 2, glassW, 2); r(C.glassFrame, hx + hW - glassW - 2, gy + 2, glassW, 2)
          r(C.mouth, cx - 3, gy + 11, 6, 1) // Straight thin mouth straight across under pressure
          drawDefaultFace = false
        } else if (row === 24 && !isBack && !isSide) { // MOON - Happy eyes
          r(C.glassFrame, hx + 2, gy, glassW, 2); r(C.glassFrame, hx + hW - glassW - 2, gy, glassW, glassH)
          r(C.mouth, cx - 3, gy + 10, 6, 3); r('#fff', cx - 2, gy + 10, 4, 1) // Open smile with teeth
          r(C.blush, hx + 2, gy + 6, 4, 3); r(C.blush, hx + hW - 6, gy + 6, 4, 3)
          drawDefaultFace = false
        } else if (row === 25 && !isBack && !isSide) { // BAGHOLDER
          r(C.glassFrame, hx + 2, gy + 2, glassW, 2); r(C.glassFrame, hx + hW - glassW - 2, gy + 2, glassW, 2)
          r(C.mouth, cx - 3, gy + 10, 6, 3); p('#fff', cx - 3, gy + 11); p('#fff', cx + 2, gy + 11) // grimace sweat
          r('#60a5fa', hx - 4, gy, 2, 4); r('#60a5fa', hx + hW + 2, gy + 2, 2, 4) // sweat drops
          drawDefaultFace = false
        } else if (row === 26 && !isBack && !isSide) { // COPIUM
          if (cycle === 0 || cycle === 1) { // INHALE
            r('#16a34a', hx + 2, gy, glassW, 2); r('#16a34a', hx + hW - glassW - 2, gy, glassW, 2) // bliss eyes
          } else { // EXHALE
            r('#fff', hx + 2, gy - 2, 8, 8); r('#fff', hx + hW - 10, gy - 2, 8, 8); p('#000', hx + 5, gy + 2); p('#000', hx + hW - 7, gy + 2) // crying wide eyes
            r('#60a5fa', hx - 4, gy + 6, 2, 4); r('#60a5fa', hx + hW + 2, gy + 6, 2, 4)
          }
          drawDefaultFace = false
        } else if (row === 27 && !isBack && !isSide) { // RUG PULL
          r('#fff', hx + 2, gy, 8, 8); r('#fff', hx + hW - 10, gy, 8, 8) 
          r('#000', hx + 4 + (cycle%2)*2, gy + 2 + (cycle%2)*2, 4, 4); r('#000', hx + hW - 8 - (cycle%2)*2, gy + 2 + (cycle%2)*2, 4, 4) // dizzy spiral pupils
          r(C.mouth, cx - 4, gy + 9, 8, 5); r('#fff', cx - 3, gy + 10, 6, 2) // screaming mouth
          drawDefaultFace = false
        } else if (row === 28 && !isBack && !isSide) { // LAMBO
          r('#000', hx, gy - 2, 10, 8); r('#000', hx + hW - 10, gy - 2, 10, 8) // thug life shades
          r('#fff', hx + 2, gy, 4, 2); r('#fff', hx + hW - 8, gy, 4, 2) // shades glint
          r(C.mouth, cx - 3, gy + 10, 6, 3); r('#fff', cx - 2, gy + 10, 4, 1) // cool smile
          drawDefaultFace = false
        } else if (row === 19 && !isBack && !isSide) { // BRRR
          r('#fff', hx + 2, gy - 2, 10, 10); r('#fff', hx + hW - 12, gy - 2, 10, 10) 
          p('#000', hx + 6, gy + 2); p('#000', hx + hW - 8, gy + 2) // manic tiny pupils
          r(C.mouth, cx - 4, gy + 10, 8, 5); r('#fff', cx - 4, gy + 10, 8, 2) // manic grin
          drawDefaultFace = false
        } else if (row === 35 && !isBack && !isSide) { // FAT FINGER
          r('#000', hx + 1, gy + 1, glassW - 2, 4); r('#000', hx + hW - glassW - 1, gy + 1, glassW - 2, 4) // focused tiny eyes
          r(C.mouth, cx - 2, gy + 11, 4, 1) // focused line mouth
          drawDefaultFace = false
        } else if (row === 36 && !isBack && !isSide) { // 100x LEVERAGE
          r('#fbbf24', hx + 2, gy - 2, 10, 10); r('#fbbf24', hx + hW - 12, gy - 2, 10, 10) // Golden eyes
          r(C.mouth, cx - 4, gy + 10, 8, 3); r('#fff', cx - 3, gy + 10, 6, 1) // greedy smile
          drawDefaultFace = false
        } else if (row === 37 && !isBack && !isSide) { // TENDIES
          r(C.glassFrame, hx + 2, gy, glassW, 2); r(C.glassFrame, hx + hW - glassW - 2, gy, glassW, 2)
          r(C.mouth, cx - 3, gy + 10, 6, 3); r('#fff', cx - 2, gy + 11, 4, 1) // happy munching
          drawDefaultFace = false
        } else if (row === 38 && !isBack && !isSide) { // WHALE ATTACK
          r('#60a5fa', hx + 2, gy - 2, 10, 10); r('#60a5fa', hx + hW - 12, gy - 2, 10, 10) // blue wide eyes
          r(C.mouth, cx - 4, gy + 12, 8, 2) // gargling/drowning mouth
          drawDefaultFace = false
        } else if (row === 39 && !isBack && !isSide) { // FED PRINTING
          r(C.glassFrame, hx + 2, gy + 3, glassW, 1); r(C.glassFrame, hx + hW - glassW - 2, gy + 3, glassW, 1) // squinting
          r(C.mouth, cx - 3, gy + 10, 6, 1) // overwhelmed line mouth
          drawDefaultFace = false
        } else if (row === 40 && !isBack && !isSide) { // GAS WAR
          r('#ef4444', hx + 2, gy - 2, 8, 8); r('#ef4444', hx + hW - 10, gy - 2, 8, 8) // Red burning eyes
          r(C.mouth, cx - 4, gy + 10, 8, 4); r('#000', cx - 2, gy + 11, 4, 2) // Screaming
          drawDefaultFace = false
        } else if (row === 41 && !isBack && !isSide) { // TAX MAN
          r('#fff', hx + 2, gy - 2, 10, 10); r('#fff', hx + hW - 12, gy - 2, 10, 10) // Surprised white eyes
          p('#000', hx + 6, gy + 3); p('#000', hx + hW - 8, gy + 3) // Tiny pupils
          r(C.mouth, cx - 5, gy + 11, 10, 1) // Stressed line
          drawDefaultFace = false
        } else if (row === 42 && !isBack && !isSide) { // ALPHA / SHH
          const lookX = (cycle % 2 === 0) ? -2 : 2
          r('#000', hx+5+lookX, gy+3, 2, 2); r('#000', hx+hW-7+lookX, gy+3, 2, 2) // Shifty eyes
          r(C.mouth, cx - 1, gy + 10, 2, 2) // Small 'o' mouth for whispering
          drawDefaultFace = false
        } else if (row === 43 && !isBack && !isSide) { // PUPPETEER
          r('#fbbf24', hx + 2, gy, glassW, glassH); r('#fbbf24', hx + hW - glassW - 2, gy, glassW, glassH) // Devious gold eyes
          r(C.mouth, cx - 4, gy + 11, 8, 4); r('#fff', cx - 3, gy + 11, 6, 1) // Devious grin
          drawDefaultFace = false
        } else if (row === 44 && !isBack && !isSide) { // SYSTEM GLITCH
          const gOff = (cycle % 2 === 0) ? 2 : -2
          r('#0f0', hx + 2 + gOff, gy, 4, 4); r('#f0f', hx + hW - 6 - gOff, gy + 4, 4, 4) // Glitch pixels
          r(C.mouth, cx - 4 + gOff, gy + 10, 8, 1)
          drawDefaultFace = false
        }
        
        if (drawDefaultFace) {
          drawFaceDefault(paint, C, { hx, gy, hW, cx, glassW, glassH })
        }
      }
    }

    // Overlays (Hands / Hammering)
    if (row === 13) {
      if (cycle === 0) {
        r(C.suit, cx - 9, ty + 1, 4, 6); r(C.skin, cx - 9, ty + 7, 4, 3)
        r(C.suit, cx + 5, ty + 1, 4, 6); r(C.skin, cx + 5, ty + 7, 4, 3)
      } else if (cycle === 1) {
        r(C.suit, cx - 14, ty - 1, 10, 4); r(C.skin, cx - 16, ty - 1, 4, 4)
        r(C.suit, cx + 4, ty - 1, 10, 4); r(C.skin, cx + 12, ty - 1, 4, 4)
      } else {
        // HIDE ARMS at peak facepalm
      }
    } else if (row === 14) {
      // HAMMERING ARMS (Alternating)
      const hammerL = (cycle === 0 || cycle === 2) ? 4 : 0
      const hammerR = (cycle === 1 || cycle === 3) ? 4 : 0
      r(C.suit, cx - 12, ty + 6 + hammerL, 4, 4)
      r(C.skin, cx - 12, ty + 10 + hammerL, 4, 3)
      r(C.suit, cx + 8, ty + 6 + hammerR, 4, 4)
      r(C.skin, cx + 8, ty + 10 + hammerR, 4, 3)
    } else if (row === 9 && !isBack && !isSide) {
      // POINT
      r(C.suit, cx + 5, ty + 2, 6, 2)
      r(C.skin, cx + 11, ty + 2, 4, 2)
    } else if (row === 12 && !isBack && !isSide) {
      // CHEER
      const bnc = (cycle % 2 === 0) ? -2 : 0
      r(C.suit, cx - 11, ty + bnc, 3, 6)
      r(C.skin, cx - 11, ty - 4 + bnc, 3, 4)
      r(C.suit, cx + 8, ty + bnc, 3, 6)
      r(C.skin, cx + 8, ty - 4 + bnc, 3, 4)
    } else if (row === 5 && !isBack && !isSide) {
      // DRAMATIC MEME READ (Anime 16-bit Style)
      const bnc = (cycle % 2 === 0) ? 1 : 0

      // Giant Glowing Book
      const bY = ty + 6 + bnc
      r('rgba(59, 130, 246, 0.4)', cx - 12, bY - 2, 24, 16) // Blue Glow
      r('#fff', cx - 10, bY, 20, 12) // Pages base
      r('#e5e7eb', cx - 10, bY + 1, 9, 10) // Left page shade
      r('#f3f4f6', cx + 1, bY + 1, 9, 10) // Right page shade
      r('#1e3a8a', cx - 1, bY, 2, 12) // Spine
      
      // Text squiggles
      r('#9ca3af', cx - 8, bY + 3, 6, 1); r('#9ca3af', cx - 8, bY + 5, 5, 1); r('#9ca3af', cx - 8, bY + 7, 7, 1)
      r('#9ca3af', cx + 2, bY + 3, 7, 1); r('#9ca3af', cx + 2, bY + 5, 5, 1); r('#9ca3af', cx + 2, bY + 7, 6, 1)
      
      // Arms holding book up high
      r(C.suit, cx - 11, ty + 2 + bnc, 3, 6)
      r(C.skin, cx - 9, bY + 4, 3, 3) 
      r(C.suit, cx + 8, ty + 2 + bnc, 3, 6)
      r(C.skin, cx + 6, bY + 4, 3, 3) 
      
      // Intense Glasses Glint (Gendo Ikari style crosses)
      const gy = ty - 8 
      r('rgba(255, 255, 255, 0.95)', cx - 8, gy + bnc, 7, 5) // Left lens opaque
      r('rgba(255, 255, 255, 0.95)', cx + 1, gy + bnc, 7, 5) // Right lens opaque
      p('#fff', cx + 4, gy - 1 + bnc); p('#fff', cx + 4, gy + 5 + bnc)
      p('#fff', cx + 3, gy + 2 + bnc); p('#fff', cx + 5, gy + 2 + bnc)
    } else if (row === 20 && !isBack && !isSide) {
      // MARGIN CALL (Rekt) - Phone on fire
      const pBnc = (cycle % 2) ? 1 : 0
      r('#ef4444', cx - 14, ty + 2 + pBnc, 6, 8) // Red phone receiver
      r(C.suit, cx - 12, ty + 6 + pBnc, 4, 6) // Arm
      r(C.skin, cx - 14, ty + 4 + pBnc, 4, 3) // Hand
      
      const f1 = cycle === 0 || cycle === 2 ? '#f97316' : '#eab308'
      const f2 = cycle === 1 || cycle === 3 ? '#f97316' : '#eab308'
      r(f1, cx - 16, ty - 2 + pBnc, 4, 4); p('#ef4444', cx - 15, ty - 3 + pBnc)
      r(f2, cx - 12, ty - 4 + pBnc, 2, 6)
    } else if (row === 22 && !isBack && !isSide) {
      // SMASH BUY - Green Button
      r('#1f2937', cx - 12, ty + 12, 24, 6) // Button Base
      const pressed = (cycle === 1 || cycle === 3)
      const btnY = pressed ? ty + 10 : ty + 6
      r('#22c55e', cx - 10, btnY, 20, 6) // Green button
      if (!pressed) r('#4ade80', cx - 8, btnY + 1, 16, 2) // Glint
      
      r(C.suit, cx - 8, ty + 2, 4, pressed ? 8 : 4)
      r(C.suit, cx + 4, ty + 2, 4, pressed ? 8 : 4)
      r(C.skin, cx - 8, btnY - 2, 4, 4) 
      r(C.skin, cx + 4, btnY - 2, 4, 4) 
      
      const aY = ty - 4 - cycle * 2
      r('#22c55e', cx - 16, aY, 4, 8); r('#22c55e', cx - 18, aY + 2, 8, 2); p('#22c55e', cx - 16, aY - 1)
      r('#22c55e', cx + 12, aY + 4, 4, 8); r('#22c55e', cx + 10, aY + 6, 8, 2); p('#22c55e', cx + 12, aY + 3)
    } else if (row === 23 && !isBack && !isSide) {
      // PANIC DUMP - Red Button
      r('#1f2937', cx - 12, ty + 12, 24, 6)
      const pressed = (cycle === 0 || cycle === 2) 
      const btnY = pressed ? ty + 10 : ty + 6
      r('#ef4444', cx - 10, btnY, 20, 6) 
      if (!pressed) r('#f87171', cx - 8, btnY + 1, 16, 2) 
      
      r(C.suit, cx - 8, ty + 2, 4, pressed ? 8 : 4)
      r(C.suit, cx + 4, ty + 2, 4, pressed ? 8 : 4)
      r(C.skin, cx - 8, btnY - 2, 4, 4) 
      r(C.skin, cx + 4, btnY - 2, 4, 4) 
      
      const aY = ty + cycle * 3
      r('#ef4444', cx - 16, aY, 4, 8); r('#ef4444', cx - 18, aY + 6, 8, 2); p('#ef4444', cx - 16, aY + 8)
      r('#ef4444', cx + 12, aY - 4, 4, 8); r('#ef4444', cx + 10, aY + 2, 8, 2); p('#ef4444', cx + 12, aY + 4)
    } else if (row === 21 && !isBack && !isSide) {
      // DIAMOND HANDS
      const shakeX = (cycle % 2 === 0) ? -1 : 1
      const shakeY = (cycle % 2 === 0) ? 0 : 1
      r(C.suit, cx - 12 + shakeX, ty, 4, 8); r(C.skin, cx - 10 + shakeX, ty - 4, 4, 4)
      r(C.suit, cx + 8 + shakeX, ty, 4, 8); r(C.skin, cx + 6 + shakeX, ty - 4, 4, 4)
      
      const dY = ty - 18 + shakeY
      r('#06b6d4', cx - 12 + shakeX, dY + 4, 24, 8) 
      r('#22d3ee', cx - 8 + shakeX, dY, 16, 4) 
      r('#0891b2', cx - 6 + shakeX, dY + 12, 12, 6) 
      r('#164e63', cx - 2 + shakeX, dY + 18, 4, 4) 
      
      if (cycle === 1) { p('#fff', cx - 14, dY); r('#fff', cx - 16, dY + 1, 5, 1); p('#fff', cx - 14, dY + 2) }
      else if (cycle === 3) { p('#fff', cx + 12, dY + 14); r('#fff', cx + 10, dY + 15, 5, 1); p('#fff', cx + 12, dY + 16) }
    } else if (row === 24 && !isBack && !isSide) {
      // MAKE IT RAIN
      r(C.suit, cx - 14, ty - 2, 4, 8); r(C.skin, cx - 14, ty - 6, 4, 4)
      r(C.suit, cx + 10, ty - 2, 4, 8); r(C.skin, cx + 10, ty - 6, 4, 4)
      
      const mY1 = cycle * 4
      const mY2 = ((cycle + 2) % 4) * 4
      r('#22c55e', cx - 16, ty - 10 + mY1, 6, 3); p('#166534', cx - 14, ty - 9 + mY1)
      r('#22c55e', cx + 12, ty - 8 + mY2, 6, 3); p('#166534', cx + 14, ty - 7 + mY2)
      r('#eab308', cx - 8, ty - 16 + mY2, 4, 4); r('#fef08a', cx - 7, ty - 15 + mY2, 2, 2)
      r('#eab308', cx + 6, ty - 14 + mY1, 4, 4); r('#fef08a', cx + 7, ty - 13 + mY1, 2, 2)
    } else if (row === 35 && !isBack && !isSide) {
      // FAT FINGER (Panic Typing)
      const shakeX = (cycle % 2 === 0) ? -2 : 2
      r(C.suit, cx - 10 + shakeX, ty + 2, 4, 6); r(C.skin, cx - 12 + shakeX, ty + 6, 6, 4)
      r(C.suit, cx + 6 + shakeX, ty + 2, 4, 6); r(C.skin, cx + 6 + shakeX, ty + 6, 6, 4)
      
      // The "Explosion" on frame 3
      if (cycle === 3) {
        r('#ef4444', cx - 20, ty - 10, 40, 30) // Red burst
        r('#f97316', cx - 15, ty - 5, 30, 20) // Orange core
        r('#fbbf24', cx - 10, ty, 20, 10) // Yellow inner
      }
    } else if (row === 36 && !isBack && !isSide) {
      // 100x LEVERAGE
      r(C.suit, cx - 10, ty + 2, 4, 8); r(C.skin, cx - 11, ty + 8, 6, 5)
      r(C.suit, cx + 6, ty + 2, 4, 8); r(C.skin, cx + 5, ty + 8, 6, 5)
      
      // Glowing 100x sign
      const gColor = (cycle % 2 === 0) ? '#fbbf24' : '#f59e0b'
      r(gColor, cx - 18, ty - 14, 36, 12)
      r('#000', cx - 16, ty - 10, 32, 4) // "100x" text block
      
      // Liquidation Lightning on cycle 3
      if (cycle === 3) {
        r('#fef08a', cx - 2, ty - 30, 4, 40)
        r('#fef08a', cx - 10, ty - 10, 20, 4)
      }
    } else if (row === 37 && !isBack && !isSide) {
      // TENDIES (Golden Nuggets)
      r('#fff', cx - 8, ty - 10, 16, 4) // Chef hat base
      r('#fff', cx - 6, ty - 16, 12, 8) // Chef hat top
      
      // Frying Pan
      r('#1f2937', cx - 16, ty + 6, 32, 6)
      r('#374151', cx + 16, ty + 8, 12, 2) // Handle
      
      // Golden Nuggets jumping
      const nY = (cycle % 2 === 0) ? -4 : 0
      r('#fbbf24', cx - 8, ty + 4 + nY, 4, 4)
      r('#fbbf24', cx + 2, ty + 2 + nY, 4, 4)
      r('#fbbf24', cx - 2, ty + 6 + nY, 4, 4)
    } else if (row === 38 && !isBack && !isSide) {
      // WHALE ATTACK (Splash)
      const splashH = cycle * 8
      r('#3b82f6', cx - 24, ty + 12 - splashH, 48, splashH) // Rising water
      
      // Whale Tail peak on cycle 2
      if (cycle === 2) {
        r('#1e40af', cx - 10, ty - 10, 20, 12) // Tail base
        r('#1e40af', cx - 20, ty - 18, 12, 8); r('#1e40af', cx + 8, ty - 18, 12, 8) // Tail fins
      }
    } else if (row === 39 && !isBack && !isSide) {
      // FED PRINTING (Money Bag Drop)
      r(C.suit, cx - 10, ty + 2, 4, 8); r(C.skin, cx - 11, ty + 8, 6, 5)
      r(C.suit, cx + 6, ty + 2, 4, 8); r(C.skin, cx + 5, ty + 8, 6, 5)
      
      // Falling Bag
      const bagY = -40 + cycle * 15
      r('#713f12', cx - 12, ty + bagY, 24, 20) // The Bag
      r('#ef4444', cx - 4, ty + 6 + bagY, 8, 8) // Red Fed Logo on bag
      
      if (cycle === 3) {
        r('rgba(34, 197, 94, 0.5)', cx - 20, ty, 40, 20) // Money cloud
      }
    } else if (row === 40 && !isBack && !isSide) {
      // GAS WAR (Agent on fire)
      const fireBnc = (cycle % 2 === 0) ? -4 : 0
      r('#f97316', cx - 18, ty - 8 + fireBnc, 36, 24) // Fire aura
      r('#fbbf24', cx - 12, ty - 4 + fireBnc, 24, 16)
      // Gas Nozzle
      r('#475569', cx + 10, ty + 4, 8, 4); r('#1f2937', cx + 18, ty + 2, 4, 8) 
      r(C.suit, cx + 8, ty, 4, 8); r(C.skin, cx + 8, ty + 8, 4, 4)
    } else if (row === 41 && !isBack && !isSide) {
      // TAX MAN (Giant Hand)
      r(C.suit, cx - 10, ty + 2, 4, 8); r(C.skin, cx - 11, ty + 8, 6, 5)
      // The Coin
      r('#fbbf24', cx + 8, ty + 10, 8, 8); r('#f59e0b', cx + 10, ty + 12, 4, 4)
      // Giant Hand grabbing
      const handY = -30 + cycle * 10
      r('#57534e', cx + 4, ty + handY, 16, 20) // Hand shadow
      r('#a8a29e', cx + 6, ty + handY + 2, 12, 16) // Fingers
    } else if (row === 42 && !isBack && !isSide) {
      // ALPHA / SHH (Secret whispering)
      r(C.suit, cx - 10, ty + 2, 4, 8); r(C.skin, cx - 11, ty + 8, 6, 5)
      // Finger to lip
      r(C.suit, cx + 4, ty + 2, 4, 6); r(C.skin, cx + 4, ty + 8, 3, 4); r(C.skin, cx - 1, ty + 6, 2, 6)
    } else if (row === 43 && !isBack && !isSide) {
      // PUPPETEER
      r(C.suit, cx - 12, ty - 2, 6, 4); r(C.skin, cx - 16, ty - 4, 6, 6) // Left hand up
      r(C.suit, cx + 8, ty - 2, 6, 4); r(C.skin, cx + 12, ty - 4, 6, 6) // Right hand up
      // Strings
      r('#fff', cx - 14, ty + 2, 1, 14); r('#fff', cx + 14, ty + 2, 1, 14)
      // Small market arrows dangling
      const mOff = (cycle % 2 === 0) ? 2 : -2
      r('#22c55e', cx - 18, ty + 16 + mOff, 8, 4); r('#ef4444', cx + 10, ty + 18 - mOff, 8, 4)
    } else if (row === 44 && !isBack && !isSide) {
      // SYSTEM GLITCH
      const shakeX = (cycle % 2 === 0) ? -2 : 2
      r(C.suit, cx - 6 + shakeX, ty + 2, 12, 14)
      // Static pixels
      for(let i=0; i<8; i++) {
        const px = cx - 12 + Math.random()*24
        const py = ty + Math.random()*20
        r((Math.random()>0.5 ? '#fff' : '#000'), px, py, 2, 2)
      }
    } else if (row === 25 && !isBack && !isSide) {
      // BAGHOLDER (Heavy Bags)
      const bnk = (cycle % 2 === 0) ? 2 : 0 // Knees buckling
      
      // Left Bag
      r('#a16207', cx - 22, ty + 2 + bnk, 14, 16)
      r('#713f12', cx - 20, ty + 4 + bnk, 10, 12)
      r('#ef4444', cx - 17, ty + 8 + bnk, 4, 4); r('#ef4444', cx - 16, ty + 7 + bnk, 2, 6) // Red '-' or '$'
      r(C.suit, cx - 14, ty + bnk, 4, 8); r(C.skin, cx - 14, ty + 6 + bnk, 4, 4) // Left arm straining
      
      // Right Bag
      r('#a16207', cx + 10, ty + 2 + bnk, 14, 16)
      r('#713f12', cx + 12, ty + 4 + bnk, 10, 12)
      r('#ef4444', cx + 15, ty + 8 + bnk, 4, 4); r('#ef4444', cx + 16, ty + 7 + bnk, 2, 6) // Red '-' or '$'
      r(C.suit, cx + 12, ty + bnk, 4, 8); r(C.skin, cx + 12, ty + 6 + bnk, 4, 4) // Right arm straining
    } else if (row === 26 && !isBack && !isSide) {
      // COPIUM OVERDOSE
      const inhale = (cycle === 0 || cycle === 1)
      const cExp = inhale ? 2 : 0 // Chest expansion
      
      // Tank on back (tubes)
      r('#22c55e', cx - 12 - cExp, ty + 2, 4, 10)
      r('#22c55e', cx + 10 + cExp, ty + 2, 4, 10)
      
      // Tubing
      r('#cbd5e1', cx - 10, ty - 6, 2, 10)
      r('#cbd5e1', cx + 10, ty - 6, 2, 10)
      
      // Copium Mask
      r('#4ade80', cx - 6, ty - 10, 14, 8)
      r('#22c55e', cx - 4, ty - 8, 10, 4)
      
      // Gas Effects on exhale
      if (!inhale) {
        const pY = (cycle === 2) ? 0 : 2
        r('rgba(74, 222, 128, 0.6)', cx - 16, ty - 6 - pY, 6, 4)
        r('rgba(74, 222, 128, 0.6)', cx - 20, ty - 8 - pY, 4, 4)
        r('rgba(74, 222, 128, 0.6)', cx + 12, ty - 4 - pY, 6, 4)
        r('rgba(74, 222, 128, 0.6)', cx + 18, ty - 6 - pY, 4, 4)
      }
      
      // Arms holding mask
      r(C.suit, cx - 12, ty + 4, 4, 4); r(C.skin, cx - 10, ty - 2, 4, 6)
      r(C.suit, cx + 10, ty + 4, 4, 4); r(C.skin, cx + 8, ty - 2, 4, 6)
    } else if (row === 27 && !isBack && !isSide) {
      // RUG PULL
      const slipX = cycle * 2
      
      // The Red Rug (sliping left)
      r('#ef4444', cx - 20 - slipX, ty + 16, 40, 4)
      r('#b91c1c', cx - 18 - slipX, ty + 17, 36, 2)
      
      // Agent falling backward (Lean right, arms flailing)
      r(C.suit, cx - 16, ty - 4 + cycle, 6, 4); r(C.skin, cx - 18, ty - 8 + cycle, 4, 4) // Left arm up
      r(C.suit, cx + 12, ty - 2 + cycle, 6, 4); r(C.skin, cx + 16, ty - 6 + cycle, 4, 4) // Right arm up
      
      // Motion blur lines
      r('#cbd5e1', cx - 14, ty - 16, 8, 2)
      r('#cbd5e1', cx - 18, ty - 10, 6, 2)
      r('#cbd5e1', cx + 10, ty - 24, 8, 2)
    } else if (row === 28 && !isBack && !isSide) {
      // LAMBO
      const bnc = (cycle % 2 === 0) ? 1 : 0
      
      // Agent holding steering wheel
      r(C.suit, cx - 12, ty + 2 + bnc, 6, 4); r(C.skin, cx - 8, ty + bnc, 4, 4)
      r(C.suit, cx + 8, ty + 2 + bnc, 6, 4); r(C.skin, cx + 6, ty + bnc, 4, 4)
      
      // Mini Red Lambo
      const lY = ty + 6 + bnc
      r('#ef4444', cx - 20, lY, 42, 12) // car body
      r('#b91c1c', cx - 18, lY + 8, 38, 4) // shadow/trim
      r('#fde047', cx - 20, lY + 2, 4, 4) // headlight L
      r('#fde047', cx + 18, lY + 2, 4, 4) // headlight R
      r('#1f2937', cx - 14, lY - 4, 30, 4) // windshield
      
      // Steering wheel
      r('#374151', cx - 6, ty + bnc, 14, 4)
      
      // Spinning wheels
      const sW = (cycle % 2 === 0) ? '#111827' : '#374151'
      const sW2 = (cycle % 2 === 0) ? '#374151' : '#111827'
      r(sW, cx - 16, lY + 10, 8, 6); r(sW2, cx - 14, lY + 12, 4, 2)
      r(sW, cx + 10, lY + 10, 8, 6); r(sW2, cx + 12, lY + 12, 4, 2)
    } else if (row === 29 && !isBack && !isSide) {
      // MONEY PRINTER GO BRRR
      const crankY = (cycle % 2 === 0) ? -2 : 4
      
      // Printer Machine
      r('#475569', cx - 22, ty - 2, 14, 20)
      r('#334155', cx - 20, ty + 2, 10, 14)
      r('#0f172a', cx - 16, ty + 6, 8, 4) // output slot
      
      // Cranking Arm
      r(C.suit, cx - 10, ty + 2, 8, 4); r(C.skin, cx - 12, ty + 2 + crankY, 4, 4) 
      r('#1f2937', cx - 14, ty + 4 + crankY, 6, 2) // Crank handle
      
      // Other arm holding on
      r(C.suit, cx + 10, ty + 4, 4, 6); r(C.skin, cx + 10, ty + 8, 4, 4)
      
    } else if (row === 30 && !isBack && !isSide) {
      // BULL TRAP - Charging Bull overlay that disappears
      const slideX = (cycle % 4) * 6
      const bullColor = (cycle < 2) ? '#94a3b8' : 'rgba(148, 163, 184, 0.3)'
      r(bullColor, cx - 20 + slideX, ty + 4, 16, 12) // Bull body
      r(bullColor, cx - 22 + slideX, ty + 6, 6, 4) // Bull head
      r('#fff', cx - 21 + slideX, ty + 5, 2, 2) // Horn
      
      // Agent panicked
      r(C.suit, cx - 6, ty + 2, 4, 6); r(C.skin, cx - 6, ty + 8, 4, 4)
      r(C.suit, cx + 2, ty + 2, 4, 6); r(C.skin, cx + 2, ty + 8, 4, 4)
    } else if (row === 31 && !isBack && !isSide) {
      // DEAD CAT BOUNCE
      const bounceY = (cycle === 1) ? -10 : (cycle === 3) ? -4 : 0
      r('#94a3b8', cx - 6, ty + 12 + bounceY, 12, 6) // The "Cat"
      p('#000', cx - 4, ty + 14 + bounceY); p('#000', cx + 3, ty + 14 + bounceY)
      
      // Agent pointing and laughing
      r(C.suit, cx + 6, ty + 4, 8, 3); r(C.skin, cx + 12, ty + 4, 4, 3) // Pointing arm
    } else if (row === 32 && !isBack && !isSide) {
      // LIQUIDATION MELT
      const meltH = 10 - cycle * 2
      r(C.suit, cx - 6, ty + (10 - meltH), 12, meltH) // Melting body
      r('rgba(239, 68, 68, 0.6)', cx - 10, ty + 8, 20, 4 + cycle * 2) // Puddle
    } else if (row === 33 && !isBack && !isSide) {
      // BUY THE DIP
      const dipY = cycle * 2
      r('#78350f', cx - 12, ty + 10, 24, 8) // The Bowl (Dip)
      r('#22c55e', cx - 10, ty + 12, 20, 4) // Green Dip
      
      // Agent diving in
      r(C.suit, cx - 4, ty - 4 + dipY, 8, 10)
      r(C.skin, cx - 4, ty + 6 + dipY, 8, 4)
    } else if (row === 34 && !isBack && !isSide) {
      // TO THE MOON (Rocket Ship)
      const rockY = -cycle * 4
      r('#cbd5e1', cx - 6, ty + 10 + rockY, 12, 18) // Rocket body
      r('#ef4444', cx - 8, ty + 24 + rockY, 16, 6) // Fins
      r('#3b82f6', cx - 3, ty + 14 + rockY, 6, 6) // Window
      
      // Fire
      const fC = (cycle % 2 === 0) ? '#f97316' : '#eab308'
      r(fC, cx - 4, ty + 28 + rockY, 8, 8)
    }
  }

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      drawAgent(col * w, row * h, row, col % 4)
    }
  }
  createSheet(scene, key, canvas, 32, 48)
}

/**
 * Create Bear agent sprite
 */
export function createBearAgent(scene, key, agentColor, isEvening = false) {
  const palette = getPalette(isEvening)
  const { agent } = palette
  const w = 32, h = 48, cols = 4
  const rows = 35
  const canvas = document.createElement('canvas')
  canvas.width = w * cols
  canvas.height = h * rows
  const ctx = canvas.getContext('2d')
  const accent = createAccentRamp(agentColor)

  const C = createAgentPalette(agent, accent, {
    skin: '#a1612f',
    skinShadow: '#6f3e1f',
    hair: '#6b3414',
    hairShadow: '#41200c',
    hairLight: '#8f4b25',
    tie: accent.muted,
    eye: '#090604'
  })
  const hW = 28, hH = 22

  const drawAgent = (ox, oy, row, cycle) => {
    const paint = createPainter(ctx, ox, oy)
    const { r, p } = paint

    const isWalking = row <= 2
    const isBack = (row === 2)
    const isSide = (row === 1 || row === 8 || row === 7)
    const bounce = (isWalking && (cycle === 1 || cycle === 3)) ? -1 : 0
    const cx = 16
    let by = 44 + bounce
    if (row === 12 && (cycle === 0 || cycle === 2)) by -= 4
    const ly = by - 6
    const ty = ly - 8
    // Removed generic drop shadow
    // r('rgba(0,0,0,0.2)', cx - 12, 41, 24, 3)
    if (row === 14) {
      // KNEES ON FLOOR (Bear Hammer)
      r(C.suitShadow, cx - 10, ly + 4, 8, 3)
      r(C.suitShadow, cx + 2, ly + 4, 8, 3)
    } else {
      drawStandingLegs(paint, C, {
        cx,
        ly,
        isSide,
        isWalking,
        cycle,
        legWidth: 5,
        shoeWidth: 5,
        stride: 3
      })
    }

    // Body
    if (row === 14) {
      // HIDE BODY FOR ABSTRACT WHINE
    } else {
      drawBusinessTorso(paint, C, {
        cx,
        ty,
        isBack,
        isSide,
        torsoW: 18,
        torsoH: 12,
        shirtW: 6,
        tieW: 2
      })
    }

    // Arms
    const isCustomMeme = row >= 20
    if (row !== 13 && row !== 14 && !isCustomMeme) {
      r(C.suit, cx - 12, ty + 2, 4, 7); r(C.skin, cx - 12, ty + 9, 4, 4)
      r(C.suit, cx + 8, ty + 2, 4, 7); r(C.skin, cx + 8, ty + 9, 4, 4)
    }

    let hy = ty - hH + 4
    const headShakeX = (row === 13 && cycle >= 2) ? (cycle === 2 ? -1 : 1) : 0
    if (row === 13) hy += (cycle === 0 ? 2 : cycle === 1 ? 5 : 9)
    if (row === 14) hy += (cycle % 2 === 0 ? 12 : 11)

    const hx = cx - hW / 2 + headShakeX

    if (isBack) {
      drawBackHead(paint, C, { hx, hy, hW, hH })
    } else {
      if ((row === 13 && cycle >= 2) || row === 14) {
        if (row === 14) {
          // ABSTRACT BEAR WHINE - Centered and Elevated
          hy = ty - 8 // Raised higher
          const faceX = cx - 12 + headShakeX // More centered
          r(C.skin, faceX, hy - 2, 6, 6) // Side ear
          r(C.hair, faceX + 2, hy, hW - 4, hH - 6)
          
          // VERTICAL TEAR STREAMS (90 degrees down)
          const tH1 = 16 + (cycle % 2) * 8
          const tH2 = 10 + ((cycle + 1) % 2) * 6
          
          // Left tears
          r('#60a5fa', faceX - 3, hy + 10, 2, tH1)
          r('#60a5fa', faceX - 6, hy + 14, 2, tH2)
          
          // Right tears
          r('#60a5fa', faceX + hW - 1, hy + 10, 2, tH1)
          r('#60a5fa', faceX + hW + 2, hy + 14, 2, tH2)
          
          // Droplet highlights
          p('#FFF', faceX - 2, hy + 10 + tH1 - 1)
          p('#FFF', faceX + hW, hy + 10 + tH1 - 1)
        } else {
          // Peak facepalm head
          r(C.skin, hx, hy + 2, 6, 6); r(C.skin, hx + hW - 6, hy + 2, 6, 6)
          drawFrontHeadShell(paint, C, { hx, hy, hW, hH })
          r('#60a5fa', hx + hW - 1, hy + 8, 3, 5); // Sweat drop instead of dark shadow
        }
      } else {
        r(C.skin, hx, hy - 2, 6, 6); r(C.skin, hx + hW - 6, hy - 2, 6, 6)
        drawFrontHeadShell(paint, C, { hx, hy, hW, hH })
        const gy = hy + 8
        if (row === 13 && cycle === 1) { r('#000', cx - 6, gy + 2, 8, 2); r('#000', cx + 3, gy + 2, 8, 2) }
        else if (row === 20 && !isBack && !isSide) { // REKT
          r('#fff', cx - 10, gy - 2, 12, 12); r('#fff', cx + 2, gy - 2, 12, 12)
          p('#000', cx - 6, gy + 4); p('#000', cx + 6, gy + 4)
          r('#000', cx - 4, gy + 12, 12, 6); r('#fff', cx - 3, gy + 13, 10, 2)
          r('rgba(0,0,0,0.5)', cx - 18, ty + 12, 36, 12)
        } else if (row === 22 && !isBack && !isSide) { // BUY
          r('#16a34a', cx - 8, gy - 1, 10, 8); r('#16a34a', cx + 2, gy - 1, 10, 8)
          r('#4ade80', cx - 6, gy + 1, 6, 4); r('#4ade80', cx + 4, gy + 1, 6, 4)
          r('#D2B48C', cx - 4, gy + 6, 8, 6); p('#000', cx - 1, gy + 7)
        } else if (row === 23 && !isBack && !isSide) { // SELL
          r('#fee2e2', cx - 10, gy, 10, 8); r('#fee2e2', cx + 4, gy, 10, 8)
          p('#000', cx - 6, gy + 4); p('#000', cx + 8, gy + 4)
          r('#000', cx - 4, gy + 8, 8, 2) // flat mouth
          const sY = gy - 4 + (cycle % 2) * 2; r('#60a5fa', cx - 10, sY, 3, 4); r('#60a5fa', cx + 11, sY + 2, 3, 4) 
        } else if (row === 21 && !isBack && !isSide) { // HODL
          r('#000', cx - 8, gy + 4, 8, 2); r('#000', cx + 4, gy + 4, 8, 2)
          r('#D2B48C', cx - 4, gy + 8, 8, 6); p('#000', cx - 1, gy + 9) // trembling mouth
        } else if (row === 24 && !isBack && !isSide) { // MOON
          r('#000', cx - 8, gy, 8, 3); r('#000', cx + 4, gy, 8, 3) 
          r('#D2B48C', cx - 4, gy + 8, 8, 6); r('#fff', cx - 2, gy + 8, 4, 2); p('#000', cx - 1, gy + 7) // smile
        } else if (row === 25 && !isBack && !isSide) { // BAGHOLDER
          r('#000', cx - 8, gy + 2, 8, 2); r('#000', cx + 4, gy + 2, 8, 2)
          r('#D2B48C', cx - 4, gy + 8, 8, 6); p('#fff', cx - 4, gy + 11); p('#fff', cx + 3, gy + 11) // grimace sweat
          r('#60a5fa', cx - 12, gy, 3, 5); r('#60a5fa', cx + 11, gy + 2, 3, 5) // sweat drops
        } else if (row === 26 && !isBack && !isSide) { // COPIUM
          if (cycle === 0 || cycle === 1) { // INHALE
            r('#16a34a', cx - 8, gy, 8, 2); r('#16a34a', cx + 4, gy, 8, 2) // bliss eyes
          } else { // EXHALE
            r('#fff', cx - 8, gy - 2, 10, 8); r('#fff', cx + 2, gy - 2, 10, 8); p('#000', cx - 4, gy + 2); p('#000', cx + 4, gy + 2) // crying wide eyes
            r('#60a5fa', cx - 8, gy + 6, 3, 5); r('#60a5fa', cx + 6, gy + 6, 3, 5)
          }
          // The breathing mask covers the mouth, drawn in body overlays
        } else if (row === 27 && !isBack && !isSide) { // RUG PULL
          r('#fff', cx - 8, gy, 8, 8); r('#fff', cx + 4, gy, 8, 8) 
          r('#000', cx - 4 + (cycle%2)*2, gy + 2 + (cycle%2)*2, 4, 4); r('#000', cx + 6 - (cycle%2)*2, gy + 2 + (cycle%2)*2, 4, 4) // dizzy spiral pupils
          r('#000', cx - 4, gy + 10, 8, 6); r('#fff', cx - 3, gy + 11, 6, 2) // screaming mouth
        } else if (row === 28 && !isBack && !isSide) { // LAMBO
          r('#000', cx - 10, gy - 2, 12, 8); r('#000', cx + 2, gy - 2, 12, 8) // thug life shades
          r('#fff', cx - 8, gy, 4, 2); r('#fff', cx + 4, gy, 4, 2) // shades glint
          r('#D2B48C', cx - 4, gy + 8, 8, 6); r('#fff', cx - 2, gy + 8, 4, 2); p('#000', cx - 1, gy + 7) // cool smil
        } else if (row === 29 && !isBack && !isSide) { // BRRR
          r('#fff', cx - 8, gy - 2, 10, 10); r('#fff', cx + 2, gy - 2, 10, 10) 
          p('#000', cx - 4, gy + 2); p('#000', cx + 6, gy + 2) // manic tiny pupils
          r('#D2B48C', cx - 4, gy + 8, 8, 6); r('#fff', cx - 4, gy + 8, 8, 2); p('#000', cx - 1, gy + 7) // manic grin
        } else if (row === 35 && !isBack && !isSide) { // FAT FINGER
          r('#000', cx - 4, gy + 1, 3, 3); r('#000', cx + 1, gy + 1, 3, 3) // intense eyes
          r('#D2B48C', cx - 3, gy + 10, 6, 4); p('#000', cx - 1, gy + 11) // focused mouth
        } else if (row === 36 && !isBack && !isSide) { // 100x LEVERAGE
          r('#fbbf24', cx - 8, gy - 2, 8, 8); r('#fbbf24', cx + 2, gy - 2, 8, 8) // Gold eyes
          r('#D2B48C', cx - 4, gy + 8, 8, 5); r('#fff', cx - 3, gy + 9, 6, 1) // greed smile
        } else if (row === 37 && !isBack && !isSide) { // TENDIES
          r('#000', cx - 6, gy + 2, 3, 3); r('#000', cx + 3, gy + 2, 3, 3)
          r('#D2B48C', cx - 2, gy + 10, 4, 3); r('#fff', cx - 1, gy + 10, 2, 1) // munching
        } else if (row === 38 && !isBack && !isSide) { // WHALE ATTACK
          r('#60a5fa', cx - 10, gy - 2, 10, 10); r('#60a5fa', cx + 2, gy - 2, 10, 10) // Blue eyes
          r('#000', cx - 4, gy + 10, 8, 4) // drowning mouth
        } else if (row === 39 && !isBack && !isSide) { // FED PRINTING
          r('#000', cx - 6, gy + 4, 3, 2); r('#000', cx + 3, gy + 4, 3, 2) // squinting
          r('#D2B48C', cx - 2, gy + 11, 4, 1) // flat line
        } else if (row === 40 && !isBack && !isSide) { // GAS WAR
          r('#ef4444', cx - 8, gy - 2, 10, 10); r('#ef4444', cx + 2, gy - 2, 10, 10) // Red burning eyes
          r('#000', cx - 4, gy + 10, 12, 6); r('#fff', cx - 3, gy + 11, 10, 2) // Screaming
        } else if (row === 41 && !isBack && !isSide) { // TAX MAN
          r('#fff', cx - 8, gy - 2, 12, 12); r('#fff', cx + 2, gy - 2, 12, 12)
          p('#000', cx - 4, gy + 4); p('#000', cx + 6, gy + 4)
          r('#000', cx - 5, gy + 12, 14, 2)
        } else if (row === 42 && !isBack && !isSide) { // ALPHA / SHH
          const lookX = (cycle % 2 === 0) ? -3 : 3
          r('#000', cx-5+lookX, gy+2, 4, 4); r('#000', cx+5+lookX, gy+2, 4, 4) // Shifty eyes
          r('#000', cx - 2, gy + 11, 4, 4); r('#D2B48C', cx - 1, gy + 11, 2, 2)
        } else if (row === 43 && !isBack && !isSide) { // PUPPETEER
          r('#fbbf24', cx - 8, gy - 1, 10, 8); r('#fbbf24', cx + 2, gy - 1, 10, 8) 
          r('#D2B48C', cx - 4, gy + 8, 8, 6); r('#fff', cx - 2, gy + 8, 4, 2); p('#000', cx - 1, gy + 7) 
        } else if (row === 44 && !isBack && !isSide) { // SYSTEM GLITCH
          const gOff = (cycle % 2 === 0) ? 3 : -3
          r('#0f0', cx - 8 + gOff, gy, 6, 6); r('#f0f', cx + 6 - gOff, gy + 4, 6, 6)
          r('#000', cx - 5 + gOff, gy + 12, 10, 2)
        } else { 
          r('#000', cx - 6, gy + 1, 3, 3); r('#000', cx + 3, gy + 1, 3, 3) 
          r('#D2B48C', cx - 4, gy + 6, 8, 6); p('#000', cx - 1, gy + 7) 
        }
      }
    }

    if (row === 13) {
      if (cycle === 0) { r(C.skin, cx - 12, ty + 9, 4, 4); r(C.skin, cx + 8, ty + 9, 4, 4) }
      else if (cycle === 1) { r(C.skin, cx - 18, ty - 2, 6, 6); r(C.skin, cx + 12, ty - 2, 6, 6) }
    } else if (row === 14) {
      // HAMMERING PAWS (Bear)
      const hammerL = (cycle % 2 === 0) ? 5 : 0
      const hammerR = (cycle % 2 !== 0) ? 5 : 0
      r(C.skin, cx - 16, ty + 9 + hammerL, 6, 6)
      r(C.skin, cx + 11, ty + 9 + hammerR, 6, 6)
    } else if (row === 9 && !isBack && !isSide) {
      // POINT (Bear)
      r(C.suit, cx + 10, ty + 2, 8, 4)
      r(C.skin, cx + 16, ty + 2, 6, 4)
    } else if (row === 12 && !isBack && !isSide) {
      // CHEER (Bear)
      const bnc = (cycle % 2 === 0) ? -3 : 0
      r(C.suit, cx - 14, ty + bnc, 4, 8)
      r(C.skin, cx - 14, ty - 6 + bnc, 4, 6)
      r(C.suit, cx + 11, ty + bnc, 4, 8)
      r(C.skin, cx + 11, ty - 6 + bnc, 4, 6)
    } else if (row === 35 && !isBack && !isSide) {
      // FAT FINGER (Bear Paws)
      const shakeY = (cycle % 2 === 0) ? -2 : 2
      r(C.suit, cx - 14, ty + 2 + shakeY, 6, 8); r(C.skin, cx - 16, ty + 10 + shakeY, 8, 6)
      r(C.suit, cx + 10, ty + 2 + shakeY, 6, 8); r(C.skin, cx + 10, ty + 10 + shakeY, 8, 6)
      if (cycle === 3) {
        r('#ef4444', cx - 24, ty - 12, 48, 36); r('#f97316', cx - 18, ty - 6, 36, 24)
      }
    } else if (row === 36 && !isBack && !isSide) {
      // 100x LEVERAGE (Bear)
      r(C.suit, cx - 12, ty + 2, 6, 10); r(C.skin, cx - 14, ty + 10, 8, 6)
      r(C.suit, cx + 8, ty + 2, 6, 10); r(C.skin, cx + 8, ty + 10, 8, 6)
      const gColor = (cycle % 2 === 0) ? '#fbbf24' : '#f59e0b'
      r(gColor, cx - 20, ty - 16, 40, 14)
      r('#000', cx - 18, ty - 12, 36, 6)
      if (cycle === 3) r('#fef08a', cx - 3, ty - 35, 6, 50)
    } else if (row === 37 && !isBack && !isSide) {
      // TENDIES (Bear Chef)
      r('#fff', cx - 10, ty - 12, 20, 6) // Chef hat
      r('#fff', cx - 8, ty - 20, 16, 10)
      r('#1f2937', cx - 18, ty + 8, 36, 8); r('#374151', cx + 18, ty + 10, 14, 2) // Pan
      const nY = (cycle % 2 === 0) ? -5 : 0
      r('#fbbf24', cx - 10, ty + 6 + nY, 6, 6); r('#fbbf24', cx + 2, ty + 4 + nY, 6, 6)
    } else if (row === 38 && !isBack && !isSide) {
      // WHALE ATTACK (Bear Splash)
      const sH = cycle * 10
      r('#3b82f6', cx - 28, ty + 14 - sH, 56, sH)
      if (cycle === 2) {
        r('#1e40af', cx - 12, ty - 12, 24, 14)
        r('#1e40af', cx - 24, ty - 22, 14, 10); r('#1e40af', cx + 10, ty - 22, 14, 10)
      }
    } else if (row === 39 && !isBack && !isSide) {
      // FED PRINTING (Bear)
      r(C.suit, cx - 12, ty + 2, 6, 10); r(C.skin, cx - 14, ty + 10, 8, 6)
      r(C.suit, cx + 8, ty + 2, 6, 10); r(C.skin, cx + 8, ty + 10, 8, 6)
      const bY = -45 + cycle * 18
      r('#713f12', cx - 14, ty + bY, 28, 24)
      r('#ef4444', cx - 5, ty + 10 + bY, 10, 10)
      if (cycle === 3) r('rgba(34, 197, 94, 0.5)', cx - 24, ty, 48, 24)
    } else if (row === 40 && !isBack && !isSide) {
      // GAS WAR (Bear fire)
      const fBnc = (cycle % 2 === 0) ? -5 : 0
      r('#f97316', cx - 22, ty - 10 + fBnc, 44, 30)
      r('#fbbf24', cx - 16, ty - 6 + fBnc, 32, 20)
      r('#475569', cx + 14, ty + 6, 12, 6); r('#1f2937', cx + 24, ty + 4, 6, 12) // Nozzle
      r(C.suit, cx + 12, ty + 2, 6, 10); r(C.skin, cx + 12, ty + 12, 6, 6)
    } else if (row === 41 && !isBack && !isSide) {
      // TAX MAN (Bear Hand)
      r(C.suit, cx - 12, ty + 2, 6, 10); r(C.skin, cx - 14, ty + 12, 8, 6)
      r('#fbbf24', cx + 12, ty + 12, 10, 10); r('#f59e0b', cx + 15, ty + 15, 4, 4) // Coin
      const hY = -35 + cycle * 12
      r('#57534e', cx + 6, ty + hY, 20, 24); r('#a8a29e', cx + 8, ty + hY + 3, 16, 18)
    } else if (row === 42 && !isBack && !isSide) {
      // ALPHA / SHH (Bear whispering)
      r(C.suit, cx - 12, ty + 2, 6, 10); r(C.skin, cx - 14, ty + 12, 8, 6)
      r(C.suit, cx + 10, ty + 2, 6, 10); r(C.skin, cx + 10, ty + 12, 8, 6); r(C.skin, cx - 1, ty + 10, 4, 10) // Paw to lip
    } else if (row === 43 && !isBack && !isSide) {
      // PUPPETEER (Bear)
      r(C.suit, cx - 16, ty, 8, 10); r(C.skin, cx - 18, ty - 6, 10, 10) 
      r(C.suit, cx + 12, ty, 8, 10); r(C.skin, cx + 14, ty - 6, 10, 10)
      r('#fff', cx - 15, ty + 4, 1, 16); r('#fff', cx + 21, ty + 4, 1, 16)
      const mO = (cycle % 2 === 0) ? 3 : -3
      r('#22c55e', cx - 22, ty + 20 + mO, 12, 6); r('#ef4444', cx + 16, ty + 22 - mO, 12, 6)
    } else if (row === 44 && !isBack && !isSide) {
      // SYSTEM GLITCH (Bear)
      const sX = (cycle % 2 === 0) ? -3 : 3
      r(C.suit, cx - 10 + sX, ty + 2, 20, 18)
      for(let i=0; i<12; i++) {
        const px = cx - 16 + Math.random()*32
        const py = ty + Math.random()*24
        r((Math.random()>0.5 ? '#fff' : '#000'), px, py, 3, 3)
      }
    } else if (row === 20 && !isBack && !isSide) {
      // MARGIN CALL (Rekt) - Phone on fire
      const pBnc = (cycle % 2) ? 1 : 0
      r('#ef4444', cx - 16, ty + 2 + pBnc, 6, 8) 
      r(C.suit, cx - 14, ty + 6 + pBnc, 6, 6) 
      r(C.skin, cx - 16, ty + 4 + pBnc, 6, 4) 
      
      const f1 = cycle === 0 || cycle === 2 ? '#f97316' : '#eab308'
      const f2 = cycle === 1 || cycle === 3 ? '#f97316' : '#eab308'
      r(f1, cx - 18, ty - 2 + pBnc, 4, 4); p('#ef4444', cx - 17, ty - 3 + pBnc)
      r(f2, cx - 14, ty - 4 + pBnc, 2, 6)
    } else if (row === 22 && !isBack && !isSide) {
      // SMASH BUY - Green Button
      r('#1f2937', cx - 14, ty + 12, 28, 6) 
      const pressed = (cycle === 1 || cycle === 3)
      const btnY = pressed ? ty + 10 : ty + 6
      r('#22c55e', cx - 12, btnY, 24, 6) 
      if (!pressed) r('#4ade80', cx - 10, btnY + 1, 20, 2) 
      
      r(C.suit, cx - 10, ty + 2, 6, pressed ? 8 : 4)
      r(C.suit, cx + 6, ty + 2, 6, pressed ? 8 : 4)
      r(C.skin, cx - 10, btnY - 2, 6, 4) 
      r(C.skin, cx + 6, btnY - 2, 6, 4) 
      
      const aY = ty - 4 - cycle * 2
      r('#22c55e', cx - 18, aY, 4, 8); r('#22c55e', cx - 20, aY + 2, 8, 2)
      r('#22c55e', cx + 16, aY + 4, 4, 8); r('#22c55e', cx + 14, aY + 6, 8, 2)
    } else if (row === 23 && !isBack && !isSide) {
      // PANIC DUMP - Red Button
      r('#1f2937', cx - 14, ty + 12, 28, 6)
      const pressed = (cycle === 0 || cycle === 2) 
      const btnY = pressed ? ty + 10 : ty + 6
      r('#ef4444', cx - 12, btnY, 24, 6) 
      if (!pressed) r('#f87171', cx - 10, btnY + 1, 20, 2) 
      
      r(C.suit, cx - 10, ty + 2, 6, pressed ? 8 : 4)
      r(C.suit, cx + 6, ty + 2, 6, pressed ? 8 : 4)
      r(C.skin, cx - 10, btnY - 2, 6, 4) 
      r(C.skin, cx + 6, btnY - 2, 6, 4) 
      
      const aY = ty + cycle * 3
      r('#ef4444', cx - 18, aY, 4, 8); r('#ef4444', cx - 20, aY + 6, 8, 2)
      r('#ef4444', cx + 16, aY - 4, 4, 8); r('#ef4444', cx + 14, aY + 2, 8, 2)
    } else if (row === 21 && !isBack && !isSide) {
      // DIAMOND HANDS
      const shakeX = (cycle % 2 === 0) ? -1 : 1
      const shakeY = (cycle % 2 === 0) ? 0 : 1
      r(C.suit, cx - 14 + shakeX, ty, 5, 8); r(C.skin, cx - 13 + shakeX, ty - 6, 5, 6)
      r(C.suit, cx + 10 + shakeX, ty, 5, 8); r(C.skin, cx + 9 + shakeX, ty - 6, 5, 6)
      
      const dY = ty - 22 + shakeY
      r('#06b6d4', cx - 14 + shakeX, dY + 6, 28, 10) 
      r('#22d3ee', cx - 10 + shakeX, dY, 20, 6) 
      r('#0891b2', cx - 8 + shakeX, dY + 16, 16, 6) 
      r('#164e63', cx - 2 + shakeX, dY + 22, 4, 4) 
      
      if (cycle === 1) { p('#fff', cx - 16, dY); r('#fff', cx - 18, dY + 1, 5, 1); p('#fff', cx - 16, dY + 2) }
      else if (cycle === 3) { p('#fff', cx + 14, dY + 16); r('#fff', cx + 12, dY + 17, 5, 1); p('#fff', cx + 14, dY + 18) }
    } else if (row === 24 && !isBack && !isSide) {
      // MAKE IT RAIN
      r(C.suit, cx - 14, ty - 2, 5, 8); r(C.skin, cx - 14, ty - 6, 5, 5)
      r(C.suit, cx + 10, ty - 2, 5, 8); r(C.skin, cx + 10, ty - 6, 5, 5)
      
      const mY1 = cycle * 4
      const mY2 = ((cycle + 2) % 4) * 4
      r('#22c55e', cx - 18, ty - 10 + mY1, 8, 4); p('#166534', cx - 16, ty - 9 + mY1)
      r('#22c55e', cx + 12, ty - 8 + mY2, 8, 4); p('#166534', cx + 14, ty - 7 + mY2)
      r('#eab308', cx - 10, ty - 16 + mY2, 5, 5); r('#fef08a', cx - 9, ty - 15 + mY2, 3, 3)
      r('#eab308', cx + 8, ty - 14 + mY1, 5, 5); r('#fef08a', cx + 9, ty - 13 + mY1, 3, 3)
    } else if (row === 25 && !isBack && !isSide) {
      // BAGHOLDER (Heavy Bags)
      const bnk = (cycle % 2 === 0) ? 2 : 0 // Knees buckling
      
      // Left Bag
      r('#a16207', cx - 22, ty + 2 + bnk, 14, 16)
      r('#713f12', cx - 20, ty + 4 + bnk, 10, 12)
      r('#ef4444', cx - 17, ty + 8 + bnk, 4, 4); r('#ef4444', cx - 16, ty + 7 + bnk, 2, 6) // Red '-' or '$'
      r(C.suit, cx - 14, ty + bnk, 5, 8); r(C.skin, cx - 14, ty + 6 + bnk, 4, 4) // Left arm straining
      
      // Right Bag
      r('#a16207', cx + 10, ty + 2 + bnk, 14, 16)
      r('#713f12', cx + 12, ty + 4 + bnk, 10, 12)
      r('#ef4444', cx + 15, ty + 8 + bnk, 4, 4); r('#ef4444', cx + 16, ty + 7 + bnk, 2, 6) // Red '-' or '$'
      r(C.suit, cx + 12, ty + bnk, 5, 8); r(C.skin, cx + 13, ty + 6 + bnk, 4, 4) // Right arm straining
    } else if (row === 26 && !isBack && !isSide) {
      // COPIUM OVERDOSE
      const inhale = (cycle === 0 || cycle === 1)
      const cExp = inhale ? 2 : 0 // Chest expansion
      
      // Tank on back (tubes)
      r('#22c55e', cx - 12 - cExp, ty + 2, 4, 10)
      r('#22c55e', cx + 10 + cExp, ty + 2, 4, 10)
      
      // Tubing
      r('#cbd5e1', cx - 10, ty - 6, 2, 10)
      r('#cbd5e1', cx + 10, ty - 6, 2, 10)
      
      // Copium Mask
      r('#4ade80', cx - 6, ty - 10, 14, 8)
      r('#22c55e', cx - 4, ty - 8, 10, 4)
      
      // Gas Effects on exhale
      if (!inhale) {
        const pY = (cycle === 2) ? 0 : 2
        r('rgba(74, 222, 128, 0.6)', cx - 16, ty - 6 - pY, 6, 4)
        r('rgba(74, 222, 128, 0.6)', cx - 20, ty - 8 - pY, 4, 4)
        r('rgba(74, 222, 128, 0.6)', cx + 12, ty - 4 - pY, 6, 4)
        r('rgba(74, 222, 128, 0.6)', cx + 18, ty - 6 - pY, 4, 4)
      }
      
      // Arms holding mask
      r(C.suit, cx - 12, ty + 4, 5, 4); r(C.skin, cx - 10, ty - 2, 4, 6)
      r(C.suit, cx + 10, ty + 4, 5, 4); r(C.skin, cx + 8, ty - 2, 4, 6)
    } else if (row === 27 && !isBack && !isSide) {
      // RUG PULL
      const slipX = cycle * 2
      
      // The Red Rug (sliping left)
      r('#ef4444', cx - 20 - slipX, ty + 16, 40, 4)
      r('#b91c1c', cx - 18 - slipX, ty + 17, 36, 2)
      
      // Agent falling backward (Lean right, arms flailing)
      r(C.suit, cx - 16, ty - 4 + cycle, 6, 4); r(C.skin, cx - 18, ty - 8 + cycle, 4, 4) // Left arm up
      r(C.suit, cx + 12, ty - 2 + cycle, 6, 4); r(C.skin, cx + 16, ty - 6 + cycle, 4, 4) // Right arm up
      
      // Motion blur lines
      r('#cbd5e1', cx - 14, ty - 16, 8, 2)
      r('#cbd5e1', cx - 18, ty - 10, 6, 2)
      r('#cbd5e1', cx + 10, ty - 24, 8, 2)
    } else if (row === 28 && !isBack && !isSide) {
      // WEN LAMBO
      const bnc = (cycle % 2 === 0) ? 1 : 0
      r(C.suit, cx - 12, ty + 2 + bnc, 6, 4); r(C.skin, cx - 8, ty + bnc, 4, 4)
      r(C.suit, cx + 8, ty + 2 + bnc, 6, 4); r(C.skin, cx + 6, ty + bnc, 4, 4)
      const lY = ty + 6 + bnc
      r('#ef4444', cx - 20, lY, 42, 12) 
      r('#b91c1c', cx - 18, lY + 8, 38, 4) 
      r('#fde047', cx - 20, lY + 2, 4, 4) 
      r('#fde047', cx + 18, lY + 2, 4, 4) 
      r('#1f2937', cx - 14, lY - 4, 30, 4) 
      r('#374151', cx - 6, ty + bnc, 14, 4)
      const sW = (cycle % 2 === 0) ? '#111827' : '#374151'
      const sW2 = (cycle % 2 === 0) ? '#374151' : '#111827'
      r(sW, cx - 16, lY + 10, 8, 6); r(sW2, cx - 14, lY + 12, 4, 2)
      r(sW, cx + 10, lY + 10, 8, 6); r(sW2, cx + 12, lY + 12, 4, 2)
    } else if (row === 29 && !isBack && !isSide) {
      // MONEY PRINTER
      const crankY = (cycle % 2 === 0) ? -2 : 4
      r('#475569', cx - 22, ty - 2, 14, 20)
      r('#334155', cx - 20, ty + 2, 10, 14)
      r('#0f172a', cx - 16, ty + 6, 8, 4)
      r(C.suit, cx - 10, ty + 2, 8, 4); r(C.skin, cx - 12, ty + 2 + crankY, 4, 4) 
      r('#1f2937', cx - 14, ty + 4 + crankY, 6, 2)
      r(C.suit, cx + 10, ty + 4, 5, 6); r(C.skin, cx + 11, ty + 8, 4, 4)
    } else if (row === 30 && !isBack && !isSide) {
      // BULL TRAP (Bear version)
      const slideX = (cycle % 4) * 6
      const bullColor = (cycle < 2) ? '#94a3b8' : 'rgba(148, 163, 184, 0.3)'
      r(bullColor, cx - 22 + slideX, ty + 4, 20, 14)
      r(bullColor, cx - 24 + slideX, ty + 6, 8, 6)
      r(C.suit, cx - 8, ty + 2, 6, 8); r(C.skin, cx - 8, ty + 10, 6, 4)
    } else if (row === 31 && !isBack && !isSide) {
      // DEAD CAT BOUNCE
      const bounceY = (cycle === 1) ? -10 : (cycle === 3) ? -4 : 0
      r('#94a3b8', cx - 8, ty + 14 + bounceY, 16, 8)
      r(C.suit, cx + 8, ty + 4, 10, 4); r(C.skin, cx + 16, ty + 4, 5, 4)
    } else if (row === 32 && !isBack && !isSide) {
      // LIQUIDATION MELT
      const meltH = 12 - cycle * 3
      r(C.suit, cx - 9, ty + (12 - meltH), 18, meltH)
      r('rgba(239, 68, 68, 0.6)', cx - 14, ty + 10, 28, 6 + cycle * 2)
    } else if (row === 33 && !isBack && !isSide) {
      // BUY THE DIP
      const dipY = cycle * 2
      r('#78350f', cx - 14, ty + 10, 28, 10)
      r('#22c55e', cx - 12, ty + 12, 24, 6)
      r(C.suit, cx - 6, ty - 4 + dipY, 12, 12)
      r(C.skin, cx - 6, ty + 8 + dipY, 12, 6)
    } else if (row === 34 && !isBack && !isSide) {
      // TO THE MOON
      const rockY = -cycle * 4
      r('#cbd5e1', cx - 8, ty + 8 + rockY, 16, 22)
      r('#ef4444', cx - 10, ty + 26 + rockY, 20, 8)
      r('#3b82f6', cx - 4, ty + 14 + rockY, 8, 8)
      const fC = (cycle % 2 === 0) ? '#f97316' : '#eab308'
      r(fC, cx - 6, ty + 34 + rockY, 12, 10)
    } else if (row === 5 && !isBack && !isSide) {
      // DRAMATIC MEME READ (Bear Anime 16-bit Style)
      const bnc = (cycle % 2 === 0) ? 1 : 0

      // Giant Glowing Book (Bear size)
      const bY = ty + 3 + bnc
      r('rgba(59, 130, 246, 0.4)', cx - 14, bY - 2, 28, 16) // Blue Glow
      r('#fff', cx - 12, bY, 24, 12) // Pages base
      r('#e5e7eb', cx - 12, bY + 1, 11, 10) // Left shade
      r('#f3f4f6', cx + 1, bY + 1, 11, 10) // Right shade
      r('#1e3a8a', cx - 1, bY, 2, 12) // Spine
      
      // Text
      r('#9ca3af', cx - 10, bY + 3, 8, 1); r('#9ca3af', cx - 10, bY + 5, 7, 1); r('#9ca3af', cx - 10, bY + 7, 9, 1)
      r('#9ca3af', cx + 2, bY + 3, 9, 1); r('#9ca3af', cx + 2, bY + 5, 7, 1); r('#9ca3af', cx + 2, bY + 7, 8, 1)
      
      // Arms holding book up high
      r(C.suit, cx - 13, ty + 2 + bnc, 4, 6)
      r(C.skin, cx - 11, bY + 4, 4, 4) 
      r(C.suit, cx + 9, ty + 2 + bnc, 4, 6)
      r(C.skin, cx + 7, bY + 4, 4, 4) 
      
      // Intense Glasses Glint (Bear Gendo Style)
      const gy = ty - 10 
      r('rgba(255, 255, 255, 0.95)', cx - 10, gy + bnc, 8, 6)
      r('rgba(255, 255, 255, 0.95)', cx + 2, gy + bnc, 8, 6)
      p('#fff', cx - 6, gy - 1 + bnc); p('#fff', cx - 6, gy + 6 + bnc)
      p('#fff', cx - 7, gy + 2 + bnc); p('#fff', cx - 5, gy + 2 + bnc)
      p('#fff', cx + 6, gy - 1 + bnc); p('#fff', cx + 6, gy + 6 + bnc)
      p('#fff', cx + 5, gy + 2 + bnc); p('#fff', cx + 7, gy + 2 + bnc)
    }
  }

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      drawAgent(col * w, row * h, row, col % 4)
    }
  }
  createSheet(scene, key, canvas, 32, 48)
}
