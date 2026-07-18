export function createCheerAnim(scene, key) {
  scene.anims.create({ key: `${key}_cheer`, frames: scene.anims.generateFrameNumbers(key, { start: 48, end: 51 }), frameRate: 8, repeat: -1 })
}
