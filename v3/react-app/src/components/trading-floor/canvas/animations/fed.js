export function createFedAnim(scene, key) {
  scene.anims.create({ key: `${key}_fed`, frames: scene.anims.generateFrameNumbers(key, { start: 156, end: 159 }), frameRate: 8, repeat: -1 })
}
