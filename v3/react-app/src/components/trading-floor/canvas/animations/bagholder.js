export function createBagholderAnim(scene, key) {
  scene.anims.create({ key: `${key}_bagholder`, frames: scene.anims.generateFrameNumbers(key, { start: 100, end: 103 }), frameRate: 8, repeat: -1 })
}
