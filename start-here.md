# Start Here: Real-Time Travel Planner

Follow this order. Each step produces something you can test before moving on.

## Files you already have
- `agent.md`: rules and JSON output format for the planning agent
- `memory.md`: decisions, schema outline, build status, open questions
- Claude Doc "Real-Time Travel App: Event Flow Walkthrough": architecture and example flow

## Day 0: Set up (about 1 hour)
- [ ] Create the project folder and a git repository
- [ ] Install Node.js, PostgreSQL and Redis (or use Docker)
- [ ] Get API keys: Claude API, Google Maps/Places, a weather API (OpenWeather), Firebase (FCM)
- [ ] Create `.env.example` listing every key and database URL, then copy it to `.env`
- [ ] Decide web, mobile or both for the first release (open question in `memory.md`)

## Step 1: Database (Day 1)
- [ ] Write `schema.sql` from the table list in `memory.md`
- [ ] Run it locally and insert one sample user, trip and a few itinerary items
- [ ] **Done when:** you can query a trip with its itinerary items

## Step 2: Itinerary generation (Days 2-3)
- [ ] Write `prompts/itinerary.md` using the rules and JSON format from `agent.md`
- [ ] Build one backend function: trip inputs in, validated itinerary JSON out
- [ ] Check every returned place against Google Places and drop or fix any that don't exist
- [ ] **Done when:** a test trip produces a realistic, geographically grouped 3-day plan

## Step 3: Real-time sync (Days 4-5)
- [ ] Set up the API server with Socket.IO and one room per trip
- [ ] Implement edit item, broadcast update and the `version` check for conflicts
- [ ] Open the app in two browser tabs and confirm an edit appears in both instantly
- [ ] **Done when:** two clients stay in sync

## Step 4: First live data worker (Days 6-7)
- [ ] Define the event format in `events.md`: `{tripId, type, payload, timestamp}`
- [ ] Build the weather worker first (simplest), then flight status
- [ ] Put events on a Redis Stream
- [ ] **Done when:** a fake or real weather event appears on the queue

## Step 5: Re-planning (Days 8-10)
- [ ] Write simple rules: rain moves outdoor items indoors, a delay shifts later items
- [ ] Write `prompts/replan.md` for cases the rules cannot solve
- [ ] Store each suggestion as a `pending` row in `alerts`
- [ ] **Done when:** a test flight delay produces a stored suggestion

## Step 6: Notifications (Days 11-12)
- [ ] Send the suggestion through FCM with Accept and Decline actions
- [ ] On accept, apply changes, bump `version` and broadcast to the trip room
- [ ] **Done when:** the full loop works from event to synced change

## MVP checkpoint
After step 6 you can demo the idea end to end: a live event arrives, the app suggests a change, the user accepts, and every companion's device updates. Stop here and test with real users before adding offline mode, location tracking, expenses or group voting.

## Test without live APIs
Create `test-fixtures/` with a sample trip and a few sample events (a 2-hour flight delay, a rainy day, a closed venue). Use these through steps 4-6 so you are not blocked by API limits.

## If you get stuck
- Update `memory.md` after each step: mark it done and note any decision you changed
- Ask Claude for the next deep-dive: prompt design, SQL, or starter backend code

## Do first, today
1. Write `schema.sql`
2. Write `prompts/itinerary.md`
3. Write `events.md`
