-- Demonstration records for schema.sql. Run after schema.sql in a disposable database.
-- The venue names below are placeholders, not real recommendations or verified Places.
BEGIN;

INSERT INTO users (id, name, email, preferences)
VALUES (
    '00000000-0000-4000-8000-000000000001',
    'Sample Traveler',
    'sample-traveler@example.invalid',
    '{"pace":"balanced","interests":["food","museums"]}'::jsonb
);

INSERT INTO trips (id, owner_id, destination, start_date, end_date, budget, currency, status)
VALUES (
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    'Sample City',
    '2026-11-01',
    '2026-11-03',
    500.00,
    'USD',
    'planning'
);

INSERT INTO trip_members (trip_id, user_id, role)
VALUES (
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    'owner'
);

INSERT INTO flight_subscriptions
    (id, trip_id, provider, flight_number, scheduled_departure, scheduled_arrival, trip_day, origin, destination)
VALUES (
    '00000000-0000-4000-8000-000000000006',
    '00000000-0000-4000-8000-000000000002',
    'fixture',
    'EX123',
    '2026-11-01T14:00:00Z',
    '2026-11-01T16:00:00Z',
    1,
    'AAA',
    'BBB'
);

INSERT INTO itinerary_items
    (id, trip_id, day, start_time, end_time, place_name, place_id, type, cost, currency, notes)
VALUES
    ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 1,
     '09:00', '10:00', 'Sample Museum', NULL, 'activity', 20.00, 'USD', 'Placeholder sample record'),
    ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000002', 1,
     '12:00', '13:00', 'Sample Cafe', NULL, 'meal', 15.00, 'USD', 'Placeholder sample record'),
    ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000002', 2,
     '10:00', '11:30', 'Sample Garden', NULL, 'activity', 0.00, 'USD', 'Placeholder sample record'),
    ('00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000002', 1,
     '17:00', '18:00', 'Sample Airport Pickup', NULL, 'transfer', 40.00, 'USD', 'Linked to sample flight; proposed shift requires approval');

UPDATE itinerary_items
SET flight_subscription_id = '00000000-0000-4000-8000-000000000006'
WHERE id = '00000000-0000-4000-8000-000000000007';

COMMIT;

-- Verification query: should return the sample trip and three itinerary rows.
SELECT t.id AS trip_id,
       t.destination,
       t.start_date,
       t.end_date,
       i.day,
       i.start_time,
       i.end_time,
       i.place_name,
       i.version
FROM trips AS t
JOIN itinerary_items AS i ON i.trip_id = t.id
WHERE t.id = '00000000-0000-4000-8000-000000000002'
ORDER BY i.day, i.start_time;
