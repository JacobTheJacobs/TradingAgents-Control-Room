export function createRocketAnim(scene, key) {
  scene.anims.create({ key: `${key}_rocket`, frames: scene.anims.generateFrameNumbers(key, { start: 136, end: 139 }), frameRate: 10, repeat: -1 })
}
