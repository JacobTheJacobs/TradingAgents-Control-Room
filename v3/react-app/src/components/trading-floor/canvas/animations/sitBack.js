export function createSitBackAnim(scene, key) {
  scene.anims.create({ key: `${key}_sit_back`, frames: scene.anims.generateFrameNumbers(key, { start: 24, end: 27 }), frameRate: 6, repeat: -1 })
}
