import { strict as assert } from 'assert';
import { buildFill, computeMetrics } from '../helpers';
import type { Metrics, TradeFrontmatter } from '../schema';

interface TestCase {
	name: string;
	run: () => void;
}

const tests: TestCase[] = [];

const EQUALITY_TOLERANCE = 1e-9;

function test(name: string, run: () => void) {
	tests.push({ name, run });
}

const expectApprox = (actual: number | null, expected: number | null, message: string) => {
	if (actual == null || expected == null) {
		assert.strictEqual(actual, expected, message);
		return;
	}
	const delta = Math.abs(actual - expected);
	assert.ok(delta <= EQUALITY_TOLERANCE, `${message} (expected ${expected}, received ${actual}, delta ${delta})`);
};

const expectIsoString = (value: string | undefined | null, message: string) => {
	assert.ok(value, `${message} should be defined`);
	if (!value) return;
	const iso = new Date(value).toISOString();
	assert.strictEqual(iso, value, `${message} should be valid ISO string`);
};

const run = () => {
	let failures = 0;
	for (const tc of tests) {
		try {
			tc.run();
			console.log(`✓ ${tc.name}`);
		} catch (err) {
			failures += 1;
			console.error(`✗ ${tc.name}`);
			console.error(err instanceof Error ? err.stack : err);
		}
	}
	if (failures) {
		console.error(`\n${failures} test${failures === 1 ? '' : 's'} failed`);
		process.exitCode = 1;
	} else {
		console.log(`\n${tests.length} tests passed`);
	}
};

const iso = (input: string) => new Date(input + 'Z');

test('no fills returns open metrics with null aggregates', () => {
	const metrics = computeMetrics({});
	assert.strictEqual(metrics.status, 'open');
	assert.strictEqual(metrics.position, null);
	assert.strictEqual(metrics.avg_entry, null);
	assert.strictEqual(metrics.avg_exit, null);
	assert.strictEqual(metrics.realized_pnl, null);
	assert.strictEqual(metrics.r_multiple, null);
	assert.strictEqual(metrics.win, null);
});

test('single long fill remains open with null realized', () => {
	const entry = buildFill({ dir: 1, side: 'in', amount: 2, price: 100, when: iso('2023-01-01T00:00:00.000') });
	const metrics = computeMetrics({ fills: [entry] });
	assert.strictEqual(metrics.status, 'open');
	expectApprox(metrics.position, 2, 'position');
	expectApprox(metrics.avg_entry, 100, 'avg entry');
	assert.strictEqual(metrics.avg_exit, null);
	assert.strictEqual(metrics.realized_pnl, null);
	assert.strictEqual(metrics.win, null);
	assert.strictEqual(metrics.last_fill_at, entry.t);
	expectIsoString(metrics.computed_at, 'computed_at');
});

test('long trade exit with profit', () => {
	const entry = buildFill({ dir: 1, side: 'in', amount: 2, price: 100, when: iso('2023-02-01T10:00:00.000') });
	const exit = buildFill({ dir: 1, side: 'out', amount: 2, price: 120, when: iso('2023-02-02T10:00:00.000') });
	const metrics = computeMetrics({ fills: [entry, exit] });
	assert.strictEqual(metrics.status, 'closed');
	expectApprox(metrics.position, 0, 'position');
	expectApprox(metrics.avg_entry, 100, 'avg entry');
	expectApprox(metrics.avg_exit, 120, 'avg exit');
	expectApprox(metrics.realized_pnl, 40, 'realized pnl');
	assert.strictEqual(metrics.win, true);
	assert.strictEqual(metrics.last_fill_at, exit.t);
});

test('long trade exit with loss', () => {
	const entry = buildFill({ dir: 1, side: 'in', amount: 1, price: 200, when: iso('2023-03-01T10:00:00.000') });
	const exit = buildFill({ dir: 1, side: 'out', amount: 1, price: 180, when: iso('2023-03-02T10:00:00.000') });
	const metrics = computeMetrics({ fills: [entry, exit] });
	expectApprox(metrics.realized_pnl, -20, 'realized pnl');
	assert.strictEqual(metrics.win, false);
});

test('short trade exit with profit', () => {
	const entry = buildFill({ dir: -1, side: 'in', amount: 1, price: 100, when: iso('2023-04-01T10:00:00.000') });
	const exit = buildFill({ dir: -1, side: 'out', amount: 1, price: 80, when: iso('2023-04-01T20:00:00.000') });
	const metrics = computeMetrics({ action: 'short', fills: [entry, exit] });
	expectApprox(metrics.avg_entry, 100, 'avg entry');
	expectApprox(metrics.avg_exit, 80, 'avg exit');
	expectApprox(metrics.realized_pnl, 20, 'realized pnl');
	assert.strictEqual(metrics.win, true);
});

test('short trade exit with loss', () => {
	const entry = buildFill({ dir: -1, side: 'in', amount: 1, price: 400, when: iso('2023-05-01T10:00:00.000') });
	const exit = buildFill({ dir: -1, side: 'out', amount: 1, price: 420, when: iso('2023-05-01T20:00:00.000') });
	const metrics = computeMetrics({ action: 'short', fills: [entry, exit] });
	expectApprox(metrics.realized_pnl, -20, 'realized pnl');
	assert.strictEqual(metrics.win, false);
});

test('direction inferred from fills when action missing', () => {
	const entry = buildFill({ dir: -1, side: 'in', amount: 1, price: 300, when: iso('2023-06-01T10:00:00.000') });
	const exit = buildFill({ dir: -1, side: 'out', amount: 1, price: 250, when: iso('2023-06-01T20:00:00.000') });
	const metrics = computeMetrics({ fills: [entry, exit] });
	expectApprox(metrics.realized_pnl, 50, 'realized pnl');
	assert.strictEqual(metrics.win, true);
});

test('partial exit maintains open status and realized PnL for closed units', () => {
	const entry = buildFill({ dir: 1, side: 'in', amount: 3, price: 100, when: iso('2023-07-01T10:00:00.000') });
	const exit = buildFill({ dir: 1, side: 'out', amount: 1, price: 120, when: iso('2023-07-02T10:00:00.000') });
	const metrics = computeMetrics({ fills: [entry, exit] });
	assert.strictEqual(metrics.status, 'open');
	expectApprox(metrics.position, 2, 'remaining position');
	expectApprox(metrics.realized_pnl, 20, 'realized pnl');
	assert.strictEqual(metrics.win, true);
});

test('closed_at flag maintains closed status even if no position', () => {
	const entry = buildFill({ dir: 1, side: 'in', amount: 1, price: 100, when: iso('2023-08-01T10:00:00.000') });
	const exit = buildFill({ dir: 1, side: 'out', amount: 1, price: 110, when: iso('2023-08-02T10:00:00.000') });
	const metrics = computeMetrics({ fills: [entry, exit], closed_at: '2023-08-02T10:00:00.000Z' });
	assert.strictEqual(metrics.status, 'closed');
});

test('r-multiple derived from initial stop with long trade', () => {
	const entry = buildFill({ dir: 1, side: 'in', amount: 2, price: 100, when: iso('2023-09-01T10:00:00.000') });
	const exit = buildFill({ dir: 1, side: 'out', amount: 2, price: 120, when: iso('2023-09-02T10:00:00.000') });
	const metrics = computeMetrics({ fills: [entry, exit], initial_stop: 90 });
	expectApprox(metrics.realized_pnl, 40, 'realized pnl');
	expectApprox(metrics.r_multiple, 2, 'r multiple');
});

test('short r-multiple becomes negative when loss exceeds stop distance', () => {
	const entry = buildFill({ dir: -1, side: 'in', amount: 1, price: 300, when: iso('2023-10-01T10:00:00.000') });
	const exit = buildFill({ dir: -1, side: 'out', amount: 1, price: 340, when: iso('2023-10-02T10:00:00.000') });
	const metrics = computeMetrics({ action: 'short', initial_stop: 320, fills: [entry, exit] });
	expectApprox(metrics.realized_pnl, -40, 'realized pnl');
	expectApprox(metrics.r_multiple, -2, 'r multiple');
});

test('last_fill_at ignores invalid timestamps', () => {
	const entry = { ...buildFill({ dir: 1, side: 'in', amount: 1, price: 100, when: iso('2023-11-01T10:00:00.000') }), t: 'not-a-date' };
	const exit = buildFill({ dir: 1, side: 'out', amount: 1, price: 120, when: iso('2023-11-02T10:00:00.000') });
	const metrics = computeMetrics({ fills: [entry, exit] });
	assert.strictEqual(metrics.last_fill_at, exit.t);
});

if (require.main === module) {
	run();
}

export { run, tests };
