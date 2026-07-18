export function createIdleAnim(scene, key) {
  scene.anims.create({ key: `${key}_idle`, frames: scene.anims.generateFrameNumbers(key, { start: 12, end: 15 }), frameRate: 4, repeat: -1 })
}
