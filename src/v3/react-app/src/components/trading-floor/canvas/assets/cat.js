/**
 * Cat texture (TILE_TYPE 7)
 */
import { createSheet } from './helpers'

export function createCatTexture(scene) {
  const catCanvas = document.createElement('canvas')
  catCanvas.width = 128
  catCanvas.height = 96
  const cCtx = catCanvas.getContext('2d')

  const drawCatFrame = (ox, oy, dir, step) => {
    const cx = ox + 16
    const cy = oy + 24
    cCtx.fillStyle = '#FFFFFF'
    const bounce = (step === 1 || step === 3) ? -1 : 0

    if (dir === 1) { // Side
      cCtx.beginPath()
      cCtx.moveTo(cx - 6, cy - 4)
      cCtx.quadraticCurveTo(cx - 10, cy - 10, cx - 8, cy - 14)
      cCtx.lineWidth = 2
      cCtx.strokeStyle = '#FFF'
      cCtx.stroke()
      let lx = 0, rx = 0
      if (step === 1) { lx = -2; rx = 2 }
      else if (step === 3) { lx = 2; rx = -2 }
      cCtx.fillRect(cx - 4 + lx, cy - 2, 3, 4)
      cCtx.fillRect(cx + 2 + rx, cy - 2, 3, 4)
      cCtx.beginPath()
      cCtx.ellipse(cx, cy - 6 + bounce, 7, 5, 0, 0, Math.PI * 2)
      cCtx.fill()
      cCtx.beginPath()
      cCtx.arc(cx + 6, cy - 10 + bounce, 5, 0, Math.PI * 2)
      cCtx.fill()
      cCtx.beginPath()
      cCtx.moveTo(cx + 6, cy - 14 + bounce)
      cCtx.lineTo(cx + 8, cy - 18 + bounce)
      cCtx.lineTo(cx + 9, cy - 13 + bounce)
      cCtx.fill()
      cCtx.beginPath()
      cCtx.moveTo(cx + 4, cy - 14 + bounce)
      cCtx.lineTo(cx + 2, cy - 18 + bounce)
      cCtx.lineTo(cx + 1, cy - 13 + bounce)
      cCtx.fill()
    } else if (dir === 0) { // Down
      cCtx.fillRect(cx - 4, cy - 2, 3, 4)
      cCtx.fillRect(cx + 1, cy - 2, 3, 4)
      cCtx.beginPath()
      cCtx.ellipse(cx, cy - 5 + bounce, 6, 6, 0, 0, Math.PI * 2)
      cCtx.fill()
      cCtx.beginPath()
      cCtx.arc(cx, cy - 9 + bounce, 6, 0, Math.PI * 2)
      cCtx.fill()
      cCtx.beginPath()
      cCtx.moveTo(cx - 3, cy - 13 + bounce)
      cCtx.lineTo(cx - 5, cy - 17 + bounce)
      cCtx.lineTo(cx - 1, cy - 13 + bounce)
      cCtx.fill()
      cCtx.beginPath()
      cCtx.moveTo(cx + 3, cy - 13 + bounce)
      cCtx.lineTo(cx + 5, cy - 17 + bounce)
      cCtx.lineTo(cx + 1, cy - 13 + bounce)
      cCtx.fill()
      cCtx.fillStyle = '#FFC0CB'
      cCtx.fillRect(cx - 1, cy - 8 + bounce, 2, 1)
      cCtx.fillStyle = '#000'
      cCtx.fillRect(cx - 3, cy - 10 + bounce, 1, 1)
      cCtx.fillRect(cx + 2, cy - 10 + bounce, 1, 1)
    } else { // Up
      cCtx.beginPath()
      cCtx.moveTo(cx, cy - 4)
      cCtx.quadraticCurveTo(cx + 4, cy - 12, cx, cy - 16)
      cCtx.lineWidth = 2
      cCtx.strokeStyle = '#FFF'
      cCtx.stroke()
      cCtx.fillStyle = '#FFF'
      cCtx.fillRect(cx - 4, cy - 2, 3, 4)
      cCtx.fillRect(cx + 1, cy - 2, 3, 4)
      cCtx.beginPath()
      cCtx.ellipse(cx, cy - 5 + bounce, 6, 6, 0, 0, Math.PI * 2)
      cCtx.fill()
      cCtx.beginPath()
      cCtx.arc(cx, cy - 9 + bounce, 6, 0, Math.PI * 2)
      cCtx.fill()
      cCtx.beginPath()
      cCtx.moveTo(cx - 3, cy - 13 + bounce)
      cCtx.lineTo(cx - 5, cy - 17 + bounce)
      cCtx.lineTo(cx - 1, cy - 13 + bounce)
      cCtx.fill()
      cCtx.beginPath()
      cCtx.moveTo(cx + 3, cy - 13 + bounce)
      cCtx.lineTo(cx + 5, cy - 17 + bounce)
      cCtx.lineTo(cx + 1, cy - 13 + bounce)
      cCtx.fill()
    }
  }

  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      drawCatFrame(c * 32, r * 32, r, c)
    }
  }
  createSheet(scene, 'cat', catCanvas, 32, 32)
}
