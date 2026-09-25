import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/context.ts';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

const countSolutions = async () =>
  Number((await ctx.db.sql.query<{ n: number }>('select count(*) as n from firefinder.solutions'))[0]!.n);

describe('duplicate detection', () => {
  it('merges a reworded submission of the same fix into the existing solution', async () => {
    const first = await ctx.request('POST', '/solutions', {
      clientId: 'user-a-000001',
      body: {
        problem: 'Bluetooth disappeared from Windows 11 settings',
        solution: 'Restart the Bluetooth service.',
        operating_system: 'Windows 11',
        worked: true,
      },
    });
    expect(first.body.outcome).toBe('created');
    const before = await countSolutions();

    const second = await ctx.request('POST', '/solutions', {
      clientId: 'user-b-000002',
      body: {
        problem: 'Bluetooth is missing from Windows 11 settings',
        solution: 'Restart the Bluetooth Support Service.',
        operating_system: 'Windows 11',
        worked: true,
      },
    });
    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe('merged');
    expect(second.body.solution.id).toBe(first.body.solution.id);
    expect(second.body.solution.confirmation_count).toBe(2);
    expect(await countSolutions()).toBe(before);
  });

  it('does not double count when the same voter submits the same fix again', async () => {
    const res = await ctx.request('POST', '/solutions', {
      clientId: 'user-b-000002',
      body: {
        problem: 'Bluetooth is missing from Windows 11 settings',
        solution: 'Restart the Bluetooth Support Service.',
        operating_system: 'Windows 11',
        worked: true,
      },
    });
    expect(res.body.outcome).toBe('duplicate');
    expect(res.body.solution.confirmation_count).toBe(2);
  });

  it('returns the existing record for an unconfirmed duplicate without changing it', async () => {
    const res = await ctx.request('POST', '/solutions', {
      clientId: 'user-c-000003',
      body: {
        problem: 'Bluetooth vanished from Windows 11 settings',
        solution: 'Restart the Bluetooth service.',
        operating_system: 'Windows 11',
        worked: false,
      },
    });
    expect(res.body.outcome).toBe('duplicate');
    expect(res.body.solution.confirmation_count).toBe(2);
  });

  it('keeps the Windows 10 variant as its own solution', async () => {
    const res = await ctx.request('POST', '/solutions', {
      clientId: 'user-d-000004',
      body: {
        problem: 'Bluetooth disappeared from Windows 10 settings',
        solution: 'Restart the Bluetooth service.',
        operating_system: 'Windows 10',
        worked: true,
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe('created');
  });

  it('keeps genuinely different fixes for the same problem separate', async () => {
    const res = await ctx.request('POST', '/solutions', {
      clientId: 'user-e-000005',
      body: {
        problem: 'Bluetooth disappeared from Windows 11 settings',
        solution: 'Update the Intel Wireless Bluetooth driver from the laptop manufacturer website.',
        operating_system: 'Windows 11',
        worked: true,
      },
    });
    expect(res.body.outcome).toBe('created');
  });

  it('keeps opposite fixes separate', async () => {
    const enable = await ctx.request('POST', '/solutions', {
      clientId: 'user-f-000006',
      body: {
        problem: 'Laptop does not wake from sleep on Windows 11',
        solution: 'Enable Fast Startup in Control Panel > Power Options.',
        operating_system: 'Windows 11',
        worked: true,
      },
    });
    const disable = await ctx.request('POST', '/solutions', {
      clientId: 'user-g-000007',
      body: {
        problem: 'Laptop does not wake from sleep on Windows 11',
        solution: 'Disable Fast Startup in Control Panel > Power Options.',
        operating_system: 'Windows 11',
        worked: true,
      },
    });
    expect(enable.body.outcome).toBe('created');
    expect(disable.body.outcome).toBe('created');
    expect(disable.body.solution.id).not.toBe(enable.body.solution.id);
  });
});
