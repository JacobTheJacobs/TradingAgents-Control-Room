/**
 * Desk texture (TILE_TYPE 2)
 * Enhanced desk with dual monitors, chair, and accessories
 * Now 96x48 (3 grid tiles wide)
 */
import { createTex, roundRect } from './helpers'
import { getPalette } from './palette'

export function createDeskTexture(scene, isEvening = false) {
  const palette = getPalette(isEvening)
  const { wood, screen, props } = palette
  // We split the desk into TWO textures so the agent can sit BETWEEN them.
  // 1. desk_base: monitors, tabletop, drop shadow
  // 2. desk_chair: just the chair back to cover the agent's back

  // --- DESK BASE ---
  createTex(scene, 'desk_base', 96, 48, (dCtx) => {
    const rect = (ctx, c, x, y, w, h) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h) }
    
    // Color Palette
    const woodMain = wood.main
    const woodLight = wood.light
    const woodDark = wood.dark
    const woodDeep = wood.deep
    const border = wood.border

    // 1. DROP SHADOW
    dCtx.fillStyle = props.shadow
    dCtx.fillRect(6, 20, 84, 26)

    // 2. DESK LEGS (Back)
    rect(dCtx, woodDeep, 8, 32, 4, 12)
    rect(dCtx, woodDeep, 84, 32, 4, 12)

    // 3. MAIN DESK BODY
    // Base shadow block
    rect(dCtx, woodDeep, 2, 16, 92, 16)
    // Dark Front Panel
    rect(dCtx, woodDark, 2, 16, 92, 8)
    // Wood Side Accents
    rect(dCtx, woodDeep, 2, 16, 2, 16)
    rect(dCtx, woodDeep, 92, 16, 2, 16)
    
    // 4. DESKTOP SURFACE
    // Shadow under the top
    rect(dCtx, border, 2, 14, 92, 2)
    // Main top surface
    rect(dCtx, woodMain, 2, 10, 92, 6)
    // Highlighted edge
    rect(dCtx, woodLight, 2, 10, 92, 1)

    // 6. MONITORS (drawn here on base)
    const screenColor = screen.screen
    
    // Left Monitor - Data/Lines
    rect(dCtx, border, 12, -1, 22, 16)   // Border
    rect(dCtx, screen.frameInner, 13, 0, 20, 14)  // Frame
    rect(dCtx, screenColor, 15, 2, 16, 10) // Screen
    // Green data blips
    rect(dCtx, screen.chartDim, 16, 4, 2, 2)
    rect(dCtx, screen.chartDim, 20, 6, 2, 4)
    rect(dCtx, screen.chart, 24, 3, 2, 6)

    // Right Monitor - Chart
    rect(dCtx, border, 62, -1, 22, 16)  // Border
    rect(dCtx, screen.frameInner, 63, 0, 20, 14) // Frame
    rect(dCtx, screenColor, 65, 2, 16, 10) // Screen
    // Green line chart
    dCtx.strokeStyle = screen.chart
    dCtx.setLineDash([1, 1]) // Pixelated dash
    dCtx.lineWidth = 1
    dCtx.beginPath()
    dCtx.moveTo(66, 10)
    dCtx.lineTo(70, 6)
    dCtx.lineTo(74, 8)
    dCtx.lineTo(80, 4)
    dCtx.stroke()
    dCtx.setLineDash([])

    // Monitor Stands
    rect(dCtx, woodDeep, 22, 11, 2, 5)
    rect(dCtx, woodDeep, 72, 11, 2, 5)

    // 7. DESK ACCESSORIES
    // Keyboard
    rect(dCtx, props.neutralDark, 38, 13, 20, 2)
    rect(dCtx, props.neutralLight, 39, 13, 18, 1)
    
    // Paper stack
    rect(dCtx, props.paperShadow, 84, 10, 6, 4) // Shadow
    rect(dCtx, props.paper, 84, 10, 6, 3) // Papers
    rect(dCtx, props.paperBright, 84, 10, 6, 1)    // Top page highlight

    // Warm Desktop Lamp
    const lampX = 4
    const lampY = 6
    // Base
    rect(dCtx, wood.dark, lampX, lampY + 6, 4, 2)
    // Neck
    rect(dCtx, wood.main, lampX + 1, lampY + 2, 1, 5)
    // Head
    rect(dCtx, wood.light, lampX - 1, lampY, 5, 3)
    // Glow effect
    dCtx.fillStyle = props.warmGlow
    dCtx.beginPath()
    dCtx.arc(lampX + 1.5, lampY + 3.5, 3, 0, Math.PI * 2)
    dCtx.fill()
    // Tiny bright center
    rect(dCtx, props.warning, lampX + 1, lampY + 3, 1, 1)

    // 8. DESK BORDER HIGHLIGHTS (PIXEL ART STYLE)
    dCtx.strokeStyle = props.stroke
    dCtx.strokeRect(2, 10, 92, 22)
  })

  // --- DESK CHAIR ---
  createTex(scene, 'desk_chair', 96, 48, (dCtx) => {
    const rect = (ctx, c, x, y, w, h) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h) }
    const woodDark = wood.dark
    const woodDeep = wood.deep

    // 5. CHAIR (Centered at x=48)
    // Chair base/legs
    rect(dCtx, props.neutralDark, 46, 38, 4, 4)
    rect(dCtx, props.neutralDark, 42, 42, 12, 2)
    
    // Keep the chair as a low foreground mask only.
    // The readability-first agent pass pushes more torso detail upward, so the chair
    // needs to expose more chest area while still reading as a seat back.
    dCtx.fillStyle = woodDeep
    roundRect(dCtx, 41, 34, 14, 7, 2)
    // Chair cushion details
    dCtx.fillStyle = woodDark
    roundRect(dCtx, 43, 35, 10, 4, 1)
  })
}
