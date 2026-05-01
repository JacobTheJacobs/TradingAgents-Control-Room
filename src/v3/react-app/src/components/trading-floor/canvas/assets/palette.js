/**
 * Centralized palette for trading floor canvas assets
 * Metro-aligned olive-slate materials with muted wood + restrained screens.
 */

export const PALETTE = {
  day: {
    floor: {
      base: '#6b756f',
      tileA: '#636d67',
      tileB: '#5d6761',
      grid: 'rgba(155, 188, 15, 0.04)',
      bevelLight: 'rgba(255, 255, 255, 0.05)',
      bevelDark: 'rgba(0, 0, 0, 0.18)',
      vein: 'rgba(0, 0, 0, 0.05)'
    },
    wall: {
      face: '#4c5853',
      side: '#434f4a',
      corner: '#37423d',
      trim: '#5d6963',
      line: '#2d3632',
      highlight: 'rgba(155, 188, 15, 0.08)',
      shadow: 'rgba(0, 0, 0, 0.3)',
      panel: 'rgba(0, 0, 0, 0.18)'
    },
    wood: {
      main: '#5a4d3f',
      light: '#6f5f4d',
      dark: '#42362c',
      deep: '#31261f',
      border: '#241c16',
      accent: '#7b6a58'
    },
    screen: {
      frame: '#0e1412',
      frameInner: '#19221f',
      screen: '#0b1411',
      scan: 'rgba(155, 188, 15, 0.04)',
      text: '#9bbc0f',
      chart: '#84b850',
      chartDim: '#5e8f35'
    },
    ticker: {
      frame: '#0d1311',
      frameInner: '#171f1c',
      screenTop: '#0b1411',
      screenBottom: '#08100d',
      label: '#9bbc0f',
      chart: '#84b850',
      chartDim: '#5e8f35',
      scan: 'rgba(155, 188, 15, 0.03)'
    },
    tv: {
      frame: '#0e1412',
      frameInner: '#19221f',
      screenBlue: '#304a4f',
      screenRed: '#6b3b3b',
      screenGreen: '#2f5a4d',
      banner: 'rgba(6, 10, 8, 0.75)',
      text: '#d7e2d8'
    },
    window: {
      frame: '#3a4540',
      glass: '#6d8a80',
      mullion: '#505b56',
      glare: 'rgba(255, 255, 255, 0.08)'
    },
    rug: {
      base: '#2d3834',
      inner: '#34403b',
      border: '#3d4944'
    },
    props: {
      metal: '#5d6a64',
      metalDark: '#454f4a',
      metalLight: '#7a877f',
      plastic: '#55605b',
      plasticLight: '#6f7b74',
      neutralDark: '#242c28',
      neutral: '#2f3833',
      neutralLight: '#3e4843',
      paper: '#d9dfd7',
      paperShadow: '#bfc7bf',
      paperBright: '#eef3ec',
      accent: '#6aa68f',
      accentBlue: '#234750',
      accentBlueLight: '#5f8077',
      warning: '#a5863f',
      water: '#4e7f6a',
      ink: '#0d1210',
      skin: '#e0c2a7',
      leaf: '#365f4d',
      leafLight: '#42705b',
      pot: '#514035',
      shadow: 'rgba(0, 0, 0, 0.25)',
      shadowSoft: 'rgba(0, 0, 0, 0.2)',
      stroke: 'rgba(0, 0, 0, 0.3)',
      strokeSoft: 'rgba(0, 0, 0, 0.08)',
      highlightSoft: 'rgba(255, 255, 255, 0.05)',
      shadeSoft: 'rgba(0, 0, 0, 0.1)',
      warmGlow: 'rgba(165, 134, 63, 0.32)'
    },
    agent: {
      skin: '#e3c4a8',
      skinShadow: '#c7a386',
      suit: '#1f2a26',
      suitShadow: '#141d1a',
      shirt: '#e6eee3',
      glassFrame: '#0c120f',
      glassGlint: 'rgba(245, 255, 240, 0.85)',
      blush: '#d8a0a0',
      mouth: '#c08c6f',
      shoes: '#0c120f'
    },
    glow: {
      screen: {
        core: 'rgba(155, 188, 15, 0.25)',
        mid: 'rgba(155, 188, 15, 0.12)',
        edge: 'rgba(155, 188, 15, 0)'
      },
      tv: {
        core: 'rgba(120, 170, 120, 0.2)',
        mid: 'rgba(120, 170, 120, 0.1)',
        edge: 'rgba(120, 170, 120, 0)'
      }
    }
  },
  evening: {
    floor: {
      base: '#3c4440',
      tileA: '#36403b',
      tileB: '#313a35',
      grid: 'rgba(155, 188, 15, 0.03)',
      bevelLight: 'rgba(255, 255, 255, 0.04)',
      bevelDark: 'rgba(0, 0, 0, 0.22)',
      vein: 'rgba(0, 0, 0, 0.05)'
    },
    wall: {
      face: '#2f3633',
      side: '#29302c',
      corner: '#212823',
      trim: '#3b4440',
      line: '#151b17',
      highlight: 'rgba(155, 188, 15, 0.05)',
      shadow: 'rgba(0, 0, 0, 0.4)',
      panel: 'rgba(0, 0, 0, 0.22)'
    },
    wood: {
      main: '#4a4034',
      light: '#5a4d3f',
      dark: '#352c23',
      deep: '#251f19',
      border: '#1b1510',
      accent: '#655645'
    },
    screen: {
      frame: '#0b1110',
      frameInner: '#141b18',
      screen: '#08100d',
      scan: 'rgba(155, 188, 15, 0.03)',
      text: '#7fb46e',
      chart: '#5a8f4d',
      chartDim: '#3e6b39'
    },
    ticker: {
      frame: '#0b1110',
      frameInner: '#141b18',
      screenTop: '#0a1310',
      screenBottom: '#070e0c',
      label: '#7fb46e',
      chart: '#5a8f4d',
      chartDim: '#3e6b39',
      scan: 'rgba(155, 188, 15, 0.025)'
    },
    tv: {
      frame: '#0b1110',
      frameInner: '#141b18',
      screenBlue: '#22393d',
      screenRed: '#5a3232',
      screenGreen: '#23463b',
      banner: 'rgba(5, 8, 6, 0.75)',
      text: '#cbd6cb'
    },
    window: {
      frame: '#27302c',
      glass: '#4e6a61',
      mullion: '#3b4742',
      glare: 'rgba(255, 255, 255, 0.06)'
    },
    rug: {
      base: '#222c28',
      inner: '#29332f',
      border: '#323c37'
    },
    props: {
      metal: '#4f5a54',
      metalDark: '#38413d',
      metalLight: '#6c776f',
      plastic: '#434e49',
      plasticLight: '#5d6861',
      neutralDark: '#1f2723',
      neutral: '#2a332f',
      neutralLight: '#3a433f',
      paper: '#cdd4cd',
      paperShadow: '#b1bab2',
      paperBright: '#e3e9e3',
      accent: '#5e947c',
      accentBlue: '#1f3e45',
      accentBlueLight: '#537066',
      warning: '#906f34',
      water: '#3f6b58',
      ink: '#0b100e',
      skin: '#d1b398',
      leaf: '#2d5344',
      leafLight: '#376254',
      pot: '#40322a',
      shadow: 'rgba(0, 0, 0, 0.35)',
      shadowSoft: 'rgba(0, 0, 0, 0.25)',
      stroke: 'rgba(0, 0, 0, 0.4)',
      strokeSoft: 'rgba(0, 0, 0, 0.1)',
      highlightSoft: 'rgba(255, 255, 255, 0.04)',
      shadeSoft: 'rgba(0, 0, 0, 0.14)',
      warmGlow: 'rgba(144, 111, 52, 0.28)'
    },
    agent: {
      skin: '#d6b498',
      skinShadow: '#b69072',
      suit: '#1a231f',
      suitShadow: '#121814',
      shirt: '#dbe2d7',
      glassFrame: '#0a0f0d',
      glassGlint: 'rgba(235, 245, 232, 0.8)',
      blush: '#c78d8d',
      mouth: '#b07b5f',
      shoes: '#0a0f0d'
    },
    glow: {
      screen: {
        core: 'rgba(155, 188, 15, 0.2)',
        mid: 'rgba(155, 188, 15, 0.1)',
        edge: 'rgba(155, 188, 15, 0)'
      },
      tv: {
        core: 'rgba(120, 160, 120, 0.18)',
        mid: 'rgba(120, 160, 120, 0.08)',
        edge: 'rgba(120, 160, 120, 0)'
      }
    }
  }
}

export const getPalette = (isEvening = false) => (isEvening ? PALETTE.evening : PALETTE.day)
