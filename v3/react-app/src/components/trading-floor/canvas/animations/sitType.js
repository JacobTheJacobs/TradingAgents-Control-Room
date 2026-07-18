export function createSitTypeAnim(scene, key) {
  scene.anims.create({ key: `${key}_sit_type`, frames: scene.anims.generateFrameNumbers(key, { start: 16, end: 19 }), frameRate: 8, repeat: -1 })
}
