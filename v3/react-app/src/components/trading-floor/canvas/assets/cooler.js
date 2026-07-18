/**
 * Water Cooler texture (TILE_TYPE 4)
 */
import { createTex } from './helpers'
import { getPalette } from './palette'

export function createCoolerTexture(scene, isEvening = false) {
  const palette = getPalette(isEvening)
  const { props } = palette
  createTex(scene, 'cooler', 32, 48, (ctx) => {
    // Drop shadow
    ctx.fillStyle = props.shadow
    ctx.beginPath()
    ctx.ellipse(19, 48, 11, 4, 0, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = props.shadowSoft
    ctx.beginPath()
    ctx.ellipse(16, 46, 10, 3, 0, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = props.neutralDark
    ctx.fillRect(7, 40, 18, 6)
    ctx.fillStyle = props.neutral
    ctx.fillRect(7, 40, 18, 2)

    const bodyGradient = ctx.createLinearGradient(8, 20, 24, 20)
    bodyGradient.addColorStop(0, props.metal)
    bodyGradient.addColorStop(0.5, props.metalLight)
    bodyGradient.addColorStop(1, props.metalDark)
    ctx.fillStyle = bodyGradient
    ctx.fillRect(8, 22, 16, 18)

    ctx.fillStyle = props.water
    ctx.beginPath()
    ctx.arc(16, 11, 9, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = props.accent
    ctx.beginPath()
    ctx.arc(16, 13, 8, 0, Math.PI)
    ctx.fill()

    ctx.fillStyle = props.warning
    ctx.beginPath()
    ctx.arc(13, 36, 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = props.accent
    ctx.beginPath()
    ctx.arc(19, 36, 2, 0, Math.PI * 2)
    ctx.fill()
  })
}
