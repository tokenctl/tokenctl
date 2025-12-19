const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  
  // Text colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  
  // Background colors
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
};

function colorize(text, color, bgColor = null) {
  if (!process.stdout.isTTY) {
    // Not a terminal, return plain text
    return text;
  }
  
  let result = '';
  if (bgColor && colors[bgColor]) {
    result += colors[bgColor];
  }
  if (color && colors[color]) {
    result += colors[color];
  }
  result += text;
  result += colors.reset;
  return result;
}

function sectionHeader(text) {
  return colorize(` ${text} `, 'white', 'bgBlue');
}

function verdictColor(verdict) {
  switch (verdict) {
    case 'CLEAN':
      return colorize(verdict, 'black', 'bgGreen');
    case 'WATCH':
      return colorize(verdict, 'black', 'bgYellow');
    case 'RISKY':
      return colorize(verdict, 'white', 'bgRed');
    default:
      return verdict;
  }
}

module.exports = {
  colors,
  colorize,
  sectionHeader,
  verdictColor
};

