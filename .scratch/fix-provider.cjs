const fs = require('node:fs');
const file = 'src/core/provider.ts';
let t = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

t = t.replace(/this\.abortTurn\(/g, 'this.turns.abort(');
t = t.replace(/this\.driveTurn\(/g, 'this.turns.drive(');
t = t.replace(/this\.startTurn\(/g, 'this.turns.start(');

// Constants that moved to turns.ts.
const constStart = t.indexOf('/**\n * How long to collect tool calls');
const constEnd = t.indexOf('/**\n * Publishes the models');
t = t.slice(0, constStart) + t.slice(constEnd);

// Helpers that moved to turns.ts.
const tail = t.indexOf('/** Reports a thinking chunk');
t = t.slice(0, tail).trimEnd() + '\n';

t = t.replace('\tprivate readonly warm: WarmSession;\n', '\tprivate readonly warm: WarmSession;\n\tprivate readonly turns: TurnRunner;\n');
t = t.replace('\t\t}, `acpHub.models.${adapter.id}`);\n\t}', `\t\t}, \`acpHub.models.\${adapter.id}\`);
		this.turns = new TurnRunner({
			adapter,
			log: deps.log,
			models: this.models,
			saved: this.saved,
			agent: () => this.agent,
			finished: turn => this.turnEmitter.fire(turn),
			measured: measurement => this.requestEmitter.fire(measurement),
			destroySession: key => this.destroySession(key),
			isSignInRequired: error => this.isSignInRequired(error),
			promptSignIn: () => this.promptSignIn(),
			needsCredentials: () => this.needsCredentials(),
		});
	}`);
t = t.replace("import { bridgeServer, WarmSession } from './provider/warmSession';", "import { TurnRunner } from './provider/turns';\nimport { bridgeServer, WarmSession } from './provider/warmSession';");
fs.writeFileSync(file, t);
console.log('ok');
