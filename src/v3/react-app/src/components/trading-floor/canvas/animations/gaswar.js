export function createGaswarAnim(scene, key) {
  scene.anims.create({
    key: `${key}_gaswar`,
    frames: scene.anims.generateFrameNumbers(key, { start: 160, end: 163 }),
    frameRate: 8,
    repeat: -1
  })
}
