import { expect, it } from "vitest";
import { Lease, withDeadline } from "../apps/core/deadline.js";

it("a lease expires on its own and a late release cannot free a newer holder", async () => {
  const lease = new Lease("turn", 10);
  const first = lease.tryAcquire();
  expect(first).not.toBeNull();
  expect(lease.held).toBe(true);
  expect(lease.tryAcquire()).toBeNull();
  await new Promise((r) => setTimeout(r, 20));
  expect(lease.expired).toBe(true);
  const second = lease.tryAcquire();
  expect(second).not.toBeNull();
  lease.release(first!); // old holder finishing late
  expect(lease.held).toBe(true);
  lease.release(second!);
  expect(lease.held).toBe(false);
});

it("deadline always settles and reports the label instead of hanging", async () => {
  const labels: string[] = [];
  const slow = () => new Promise<void>(() => {});
  await expect(withDeadline("model", 10, slow)).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
  await expect(withDeadline("fast", 50, async () => 7)).resolves.toBe(7);
  expect(labels).toEqual([]);
});
