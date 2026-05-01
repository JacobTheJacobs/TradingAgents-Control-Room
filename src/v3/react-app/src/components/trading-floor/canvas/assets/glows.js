/**
 * Glow effects for screens and monitors
 */
import { createTex } from './helpers'
import { getPalette } from './palette'

// Screen glow texture for monitors (additive blend)
export function createScreenGlowTexture(scene, isEvening = false) {
  const palette = getPalette(isEvening)
  const { glow } = palette
  createTex(scene, 'screen_glow', 32, 24, (ctx) => {
    // Radial gradient glow
    const gradient = ctx.createRadialGradient(16, 12, 0, 16, 12, 20)
    gradient.addColorStop(0, glow.screen.core)
    gradient.addColorStop(0.5, glow.screen.mid)
    gradient.addColorStop(1, glow.screen.edge)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 32, 24)
  })
}

// TV glow texture (slightly different color)
export function createTVGlowTexture(scene, isEvening = false) {
  const palette = getPalette(isEvening)
  const { glow } = palette
  createTex(scene, 'tv_glow', 40, 30, (ctx) => {
    const gradient = ctx.createRadialGradient(20, 15, 0, 20, 15, 25)
    gradient.addColorStop(0, glow.tv.core)
    gradient.addColorStop(0.5, glow.tv.mid)
    gradient.addColorStop(1, glow.tv.edge)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 40, 30)
  })
}

export function createGlowTextures(scene, isEvening = false) {
  createScreenGlowTexture(scene, isEvening)
  createTVGlowTexture(scene, isEvening)
}
