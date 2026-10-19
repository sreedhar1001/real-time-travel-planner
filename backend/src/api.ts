import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { Pool } from "pg";

const port = Number(process.env.PORT ?? 3000);
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) throw new Error("JWT_SECRET is required");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use(express.json({ limit: "32kb" }));

app.get("/", (_req, res) => {
  res.json({ service: "real-time-travel-backend", health: "/health" });
});

const authenticate = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    const claims = jwt.verify(token, jwtSecret) as AuthClaims;
    if (!claims.sub) throw new Error("missing subject");
    res.locals.userId = claims.sub;
    next();
  } catch {
    res.status(401).json({ ok: false, error: "unauthorized" });
  }
};

app.post("/trips/:tripId/alerts/:alertId/decision", authenticate, async (req, res) => {
  const { tripId, alertId } = req.params;
  const { decision } = req.body ?? {};
  if (typeof tripId !== "string" || typeof alertId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(tripId) || !/^[0-9a-f-]{36}$/i.test(alertId) ||
      !["accept", "decline"].includes(decision)) {
    res.status(400).json({ ok: false, error: "invalid_input" });
    return;
  }
  const client = await pool.connect();
  let changedItems: unknown[] = [];
  try {
    await client.query("BEGIN");
    const member = await client.query(
      "SELECT 1 FROM trip_members WHERE trip_id = $1 AND user_id = $2",
      [tripId, res.locals.userId],
    );
    if (!member.rowCount) {
      await client.query("ROLLBACK");
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    const alertResult = await client.query(
      "SELECT suggested_change FROM alerts WHERE id = $1 AND trip_id = $2 AND status = 'pending' FOR UPDATE",
      [alertId, tripId],
    );
    if (!alertResult.rowCount) {
      await client.query("ROLLBACK");
      res.status(409).json({ ok: false, error: "alert_not_pending" });
      return;
    }
    if (decision === "accept") {
      const suggestion = alertResult.rows[0].suggested_change;
      const changes = suggestion?.options?.[0]?.changes;
      if (!Array.isArray(changes) || changes.length === 0) throw new Error("invalid stored suggestion");
      for (const change of changes) {
        if (change.action !== "move" || typeof change.itemId !== "string" ||
            !Number.isInteger(change.expectedVersion) || !Number.isInteger(change.day) ||
            typeof change.startTime !== "string" || typeof change.endTime !== "string") {
          throw new Error("unsupported stored change");
        }
        const updated = await client.query(
          `UPDATE itinerary_items SET day = $1, start_time = $2, end_time = $3,
             version = version + 1, updated_at = now()
           WHERE id = $4 AND trip_id = $5 AND version = $6 AND status = 'planned'
           RETURNING id, trip_id, day, start_time, end_time, place_name, place_id, type, status, cost, version`,
          [change.day, change.startTime, change.endTime, change.itemId, tripId, change.expectedVersion],
        );
        if (!updated.rowCount) throw new Error("version_conflict");
        changedItems.push(updated.rows[0]);
      }
    }
    await client.query(
      `UPDATE alerts SET status = $1, decided_by = $2, decided_at = now()
       WHERE id = $3 AND trip_id = $4 AND status = 'pending'`,
      [decision === "accept" ? "accepted" : "dismissed", res.locals.userId, alertId, tripId],
    );
    await client.query("COMMIT");
    for (const item of changedItems) io.to(`trip:${tripId}`).emit("itinerary:updated", item);
    res.json({ ok: true, status: decision === "accept" ? "accepted" : "dismissed", items: changedItems });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Error && error.message === "version_conflict") {
      res.status(409).json({ ok: false, error: "version_conflict" });
    } else {
      res.status(500).json({ ok: false, error: "server_error" });
    }
  } finally {
    client.release();
  }
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: false } });

type AuthClaims = jwt.JwtPayload & { sub: string };
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (typeof token !== "string") return next(new Error("unauthorized"));
  try {
    const claims = jwt.verify(token, jwtSecret) as AuthClaims;
    if (!claims.sub) return next(new Error("unauthorized"));
    socket.data.userId = claims.sub;
    next();
  } catch {
    next(new Error("unauthorized"));
  }
});

async function isTripMember(tripId: string, userId: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM trip_members WHERE trip_id = $1 AND user_id = $2",
    [tripId, userId],
  );
  return result.rowCount === 1;
}

io.on("connection", (socket) => {
  socket.on("trip:join", async (input: { tripId?: string }, ack?: (x: unknown) => void) => {
    try {
      const tripId = input?.tripId;
      if (!tripId || !(await isTripMember(tripId, socket.data.userId))) {
        ack?.({ ok: false, error: "forbidden" });
        return;
      }
      await socket.join(`trip:${tripId}`);
      ack?.({ ok: true });
    } catch {
      ack?.({ ok: false, error: "server_error" });
    }
  });

  socket.on("itinerary:update", async (input: {
    tripId?: string;
    itemId?: string;
    expectedVersion?: number;
    changes?: { startTime?: string; endTime?: string; day?: number; status?: string };
  }, ack?: (x: unknown) => void) => {
    const tripId = input?.tripId;
    const itemId = input?.itemId;
    const expectedVersion = input?.expectedVersion;
    const changes = input?.changes ?? {};
    const allowed = new Set(["startTime", "endTime", "day", "status"]);

    try {
      if (!tripId || !itemId || !Number.isInteger(expectedVersion) ||
          Object.keys(changes).length === 0 || Object.keys(changes).some((k) => !allowed.has(k))) {
        ack?.({ ok: false, error: "invalid_input" });
        return;
      }
      if (!(await isTripMember(tripId, socket.data.userId))) {
        ack?.({ ok: false, error: "forbidden" });
        return;
      }

      const fields: Record<string, string> = {
        startTime: "start_time", endTime: "end_time", day: "day", status: "status",
      };
      const values: unknown[] = [];
      const sets = Object.entries(changes).map(([key, value]) => {
        values.push(value);
        return `${fields[key]} = $${values.length}`;
      });
      values.push(itemId, tripId, expectedVersion);
      const result = await pool.query(
        `UPDATE itinerary_items SET ${sets.join(", ")}, version = version + 1, updated_at = now()
         WHERE id = $${values.length - 2} AND trip_id = $${values.length - 1} AND version = $${values.length}
         RETURNING id, trip_id, day, start_time, end_time, place_name, place_id, type, status, cost, version`,
        values,
      );

      if (result.rowCount !== 1) {
        ack?.({ ok: false, error: "version_conflict" });
        return;
      }
      const item = result.rows[0];
      io.to(`trip:${tripId}`).emit("itinerary:updated", item);
      ack?.({ ok: true, item });
    } catch {
      ack?.({ ok: false, error: "server_error" });
    }
  });
});

httpServer.listen(port, () => console.log(`API listening on ${port}`));

async function shutdown() {
  io.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
