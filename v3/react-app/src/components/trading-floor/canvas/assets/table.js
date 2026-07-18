/**
 * Table texture (TILE_TYPE 15)
 * Conference/gathering table with enhanced 2.5D depth
 */
import { createTex } from './helpers'
import { getPalette } from './palette'

export function createTableTexture(scene, isEvening = false) {
  const palette = getPalette(isEvening)
  const { wood, screen, props } = palette
  // 3x3 Meeting Table (96x96 pixels)
  const size = 96
  createTex(scene, 'table_96', size, size, (ctx) => {
    const rect = (c, x, y, w, h) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h) }
    
    // Color Palette
    const woodMain = wood.main
    const woodDark = wood.dark
    const woodDeep = wood.deep
    const border = wood.border
    const woodLight = wood.light

    // 1. DROP SHADOW
    ctx.fillStyle = props.shadowSoft
    ctx.fillRect(8, 24, 84, 68)

    // 2. SIDE PANELS (Depth)
    ctx.globalAlpha = 0.92
    rect(woodDeep, 4, 22, 88, 54) // Shadow block
    ctx.globalAlpha = 0.88
    rect(woodDark, 4, 28, 88, 18) // Softer front depth panel
    ctx.globalAlpha = 1

    // 3. TABLE TOP SURFACE
    // Border
    rect(border, 2, 8, 92, 40)
    // Main surface
    rect(woodMain, 4, 10, 88, 36)
    // Edge highlight
    rect(woodLight, 4, 10, 88, 1)

    // 4. WOOD GRAIN (Lofi style)
    ctx.strokeStyle = props.strokeSoft
    ctx.lineWidth = 1
    for (let i = 0; i < 6; i++) {
        const y = 16 + i * 5
        ctx.beginPath()
        ctx.moveTo(8, y)
        ctx.lineTo(88, y + (i % 2 === 0 ? 1 : -1))
        ctx.stroke()
    }

    // 5. DECORATIONS (Pixel Art style)
    // Blue Folder (Top Left)
    rect(props.accentBlue, 12, 14, 8, 6)
    rect(props.accentBlueLight, 13, 15, 6, 1)
    
    // Coffee Mug (Middle Right)
    rect(props.paper, 74, 18, 4, 4) // Mug
    rect(props.paper, 78, 19, 1, 2) // Handle
    rect(wood.dark, 75, 19, 2, 1) // Coffee surface

    // Open Tablet (Bottom Center-Left)
    rect(props.neutralDark, 34, 34, 12, 8)
    rect(screen.screen, 35, 35, 10, 6)
    rect(screen.chart, 36, 37, 2, 1) // Data point
    rect(props.accentBlueLight, 40, 36, 3, 1) // Bar chart

    // Pen (Bottom Right)
    rect(props.warning, 80, 38, 5, 1)
    rect(props.neutralDark, 80, 38, 1, 1)

    // Stack of papers (Top Right)
    rect(props.paperShadow, 80, 12, 8, 8)
    rect(props.paper, 80, 12, 8, 7)

    // 6. FINISHING TOUCHES
    // Soft vignette/overlay on table
    const grad = ctx.createLinearGradient(0, 10, 0, 46)
    grad.addColorStop(0, props.highlightSoft)
    grad.addColorStop(1, props.shadeSoft)
    ctx.fillStyle = grad
    ctx.fillRect(4, 10, 88, 36)

    // External border highlight
    ctx.strokeStyle = props.stroke
    ctx.lineWidth = 1
    ctx.strokeRect(4, 10, 88, 36)
  })
}

