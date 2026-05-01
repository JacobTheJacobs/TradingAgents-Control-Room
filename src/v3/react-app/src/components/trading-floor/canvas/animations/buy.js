export function createBuyAnim(scene, key) {
  scene.anims.create({ key: `${key}_buy`, frames: scene.anims.generateFrameNumbers(key, { start: 88, end: 91 }), frameRate: 8, repeat: -1 })
}
