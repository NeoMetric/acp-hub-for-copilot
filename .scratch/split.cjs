// Moves the turn methods of provider.ts into provider/turns.ts (one-off helper).
const fs = require('node:fs');
const file = 'src/core/provider.ts';
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const a = lines.slice(565, 751);
const b = lines.slice(763, 793);
const header = `/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

@@IMPORTS@@

export class TurnRunner {

	constructor(private readonly host: TurnHost) { }

`;
fs.writeFileSync('src/core/provider/turns.ts', header + a.join('\n') + '\n\n' + b.join('\n') + '\n}\n');
const rest = [...lines.slice(0, 565), ...lines.slice(751, 763), ...lines.slice(793)];
fs.writeFileSync(file, rest.join('\n'));
console.log('ok');
