export function createDeadcatAnim(scene, key) {
  scene.anims.create({ key: `${key}_deadcat`, frames: scene.anims.generateFrameNumbers(key, { start: 124, end: 127 }), frameRate: 8, repeat: -1 })
}
