/**
 * Helper functions for sprite generation
 */

// Helper function for rounded rectangles
export const roundRect = (ctx, x, y, w, h, r) => {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
  ctx.fill()
}

// Create a simple texture
export const createTex = (scene, key, w, h, draw) => {
  if (scene?.textures?.exists?.(key)) {
    scene.textures.remove(key)
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.imageSmoothingEnabled = false
    ctx.webkitImageSmoothingEnabled = false
    ctx.mozImageSmoothingEnabled = false
  }
  if (!ctx) return
  draw(ctx)
  scene.textures.addCanvas(key, canvas)
}

// Create a sprite sheet with frames
export const createSheet = (scene, key, canvas, frameW, frameH) => {
  if (scene?.textures?.exists?.(key)) {
    scene.textures.remove(key)
  }
  const ctx = canvas.getContext?.('2d')
  if (ctx) {
    ctx.imageSmoothingEnabled = false
    ctx.webkitImageSmoothingEnabled = false
    ctx.mozImageSmoothingEnabled = false
  }
  scene.textures.addCanvas(key, canvas)
  const cols = Math.floor(canvas.width / frameW)
  const rows = Math.floor(canvas.height / frameH)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      scene.textures.get(key).add(r * cols + c, 0, c * frameW, r * frameH, frameW, frameH)
    }
  }
}
