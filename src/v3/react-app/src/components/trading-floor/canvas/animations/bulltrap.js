export function createBulltrapAnim(scene, key) {
  scene.anims.create({ key: `${key}_bulltrap`, frames: scene.anims.generateFrameNumbers(key, { start: 120, end: 123 }), frameRate: 8, repeat: -1 })
}
