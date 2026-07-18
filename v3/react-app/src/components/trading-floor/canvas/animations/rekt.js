export function createRektAnim(scene, key) {
  scene.anims.create({ key: `${key}_rekt`, frames: scene.anims.generateFrameNumbers(key, { start: 80, end: 83 }), frameRate: 8, repeat: -1 })
}
