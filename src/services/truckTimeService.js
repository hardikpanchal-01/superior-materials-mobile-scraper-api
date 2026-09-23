/**
 * Truck Time Service
 *
 * Validates email sending windows based on truck schedules.
 * Computes first/last truck times for a day directly from the tenant database.
 */

const { getPool } = require('./database/postgresClient');

// Configuration
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || 'America/Chicago';
const EMAIL_TIME_WINDOW_ENABLED = process.env.EMAIL_TIME_WINDOW_ENABLED !== 'false';
const EMAIL_TIME_WINDOW_BUFFER_MINUTES = parseInt(process.env.EMAIL_TIME_WINDOW_BUFFER_MINUTES) || 0;

// Pre-cached Intl.DateTimeFormat instances (avoids re-creating per call)
const _dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const _timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true
});

// Cache for getDailyTruckTimes (5-min TTL)
const _truckTimesCache = new Map();
const TRUCK_TIMES_CACHE_TTL = 5 * 60 * 1000;

/**
 * Get current date in the configured business timezone
 * @param {Date} date - Date to format
 * @returns {string} Date in YYYY-MM-DD format
 */
function getCurrentDateInTimezone(date = new Date()) {
  return _dateFormatter.format(date);
}

/**
 * Get current time formatted for logging in the business timezone
 * @param {Date} date - Date to format
 * @returns {string} Formatted time string
 */
function formatTimeInTimezone(date = new Date()) {
  return _timeFormatter.format(date);
}

/**
 * Normalise a timestamp value to an ISO-8601 string (or null).
 *
 * `timestamptz` columns come back from `pg` as `Date` instances; callers of this
 * service expect ISO strings, so everything is coerced here.
 *
 * @param {Date|string|null} value - Timestamp value
 * @returns {string|null} ISO string, or null
 */
function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Compute the first and last truck times for a given day, directly from the
 * tenant database.
 *
 * The first truck is the earliest-starting schedule of the day; the last truck
 * is derived from the latest-starting schedule (tie-broken by the one with the
 * most loads, which extends furthest into the day) as
 * `start_time + (number_of_loads - 1) * truck_space` minutes. Where a matching
 * ticket has an actual `on_job_time`, that actual value is preferred over the
 * estimate.
 *
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {Promise<Object>} Truck times response
 */
async function getDailyTruckTimes(date) {
  const pool = getPool();
  if (!pool) {
    console.error('Database not configured for truck times lookup');
    return {
      date,
      first_truck_time: null,
      last_truck_time: null,
      error: 'Database not configured'
    };
  }

  // Check cache
  const cached = _truckTimesCache.get(date);
  if (cached && (Date.now() - cached.timestamp) < TRUCK_TIMES_CACHE_TTL) {
    return cached.data;
  }

  try {
    // Step 1: all active schedules for the day, earliest first.
    const { rows: schedules } = await pool.query(
      `SELECT s.id,
              s.start_time,
              s.number_of_loads,
              s.truck_space,
              s.plant_code,
              o.order_code
         FROM order_product_schedules s
         JOIN order_products op ON op.id = s.order_product_id
         JOIN orders o ON o.order_id = op.order_id
        WHERE s.start_time >= $1::timestamptz
          AND s.start_time <  $1::timestamptz + interval '1 day'
          AND o.removed IS DISTINCT FROM true
        ORDER BY s.start_time ASC`,
      [`${date} 00:00:00`]
    );

    // Handle no schedules case
    if (schedules.length === 0) {
      const emptyResult = {
        date,
        first_truck_time: null,
        first_truck_source: 'estimated',
        first_truck_order_code: null,
        last_truck_time: null,
        last_truck_source: 'estimated',
        last_truck_order_code: null,
        last_truck_calculation: null,
        total_schedules: 0,
        total_trucks_scheduled: 0
      };
      _truckTimesCache.set(date, { data: emptyResult, timestamp: Date.now() });
      return emptyResult;
    }

    // Step 2: first schedule (first truck base)
    const firstSchedule = schedules[0];
    const firstOrderCode = firstSchedule.order_code || null;
    const estimatedFirstTruckTime = firstSchedule.start_time;

    // Step 3: last schedule with tie-breaker (most loads wins)
    const latestStartMs = new Date(schedules[schedules.length - 1].start_time).getTime();
    const schedulesWithLatestStart = schedules.filter(
      (s) => new Date(s.start_time).getTime() === latestStartMs
    );
    const lastSchedule = schedulesWithLatestStart.reduce((max, s) =>
      s.number_of_loads > max.number_of_loads ? s : max
    );
    const lastOrderCode = lastSchedule.order_code || null;

    // Step 4: estimated last truck time
    // Formula: start_time + (number_of_loads - 1) * truck_space
    const baseTime = new Date(lastSchedule.start_time);
    const loads = lastSchedule.number_of_loads || 1;
    const spacing = lastSchedule.truck_space ?? 0;
    const offsetMs = (loads - 1) * spacing * 60 * 1000; // minutes → ms
    const estimatedLastTruckTime = new Date(baseTime.getTime() + offsetMs);

    // Step 5: hybrid — actual ticket time for the first order
    let actualFirstTruckTime = null;
    if (firstOrderCode) {
      const { rows } = await pool.query(
        `SELECT on_job_time
           FROM tickets
          WHERE order_code = $1
            AND active = true
            AND remove_reason_code IS NULL
            AND on_job_time IS NOT NULL
          ORDER BY on_job_time ASC
          LIMIT 1`,
        [firstOrderCode]
      );
      actualFirstTruckTime = rows[0]?.on_job_time ?? null;
    }

    // Step 6: hybrid — actual ticket time for the last order (last load)
    let actualLastTruckTime = null;
    if (lastOrderCode) {
      const { rows } = await pool.query(
        `SELECT on_job_time
           FROM tickets
          WHERE order_code = $1
            AND active = true
            AND remove_reason_code IS NULL
            AND on_job_time IS NOT NULL
          ORDER BY on_job_time DESC
          LIMIT 1`,
        [lastOrderCode]
      );
      actualLastTruckTime = rows[0]?.on_job_time ?? null;
    }

    // Step 7: build result — prefer actual times over estimated
    const firstTruckTime = toIso(actualFirstTruckTime) ?? toIso(estimatedFirstTruckTime);
    const firstTruckSource = actualFirstTruckTime ? 'actual' : 'estimated';
    const lastTruckTime = toIso(actualLastTruckTime) ?? estimatedLastTruckTime.toISOString();
    const lastTruckSource = actualLastTruckTime ? 'actual' : 'estimated';

    // Step 8: statistics
    const totalSchedules = schedules.length;
    const totalTrucks = schedules.reduce((sum, s) => sum + (s.number_of_loads || 0), 0);

    const data = {
      date,
      first_truck_time: firstTruckTime,
      first_truck_source: firstTruckSource,
      first_truck_order_code: firstOrderCode,
      last_truck_time: lastTruckTime,
      last_truck_source: lastTruckSource,
      last_truck_order_code: lastOrderCode,
      last_truck_calculation: {
        base_start_time: toIso(lastSchedule.start_time),
        number_of_loads: loads,
        truck_space_minutes: spacing
      },
      total_schedules: totalSchedules,
      total_trucks_scheduled: totalTrucks
    };

    console.log(`Truck times for ${date}:`, {
      first: data.first_truck_time,
      last: data.last_truck_time,
      source: `${data.first_truck_source}/${data.last_truck_source}`
    });

    _truckTimesCache.set(date, { data, timestamp: Date.now() });

    return data;
  } catch (error) {
    console.error(`Failed to compute truck times for ${date}:`, error.message);

    // Fail closed - don't send emails if we can't verify the window
    return {
      date,
      first_truck_time: null,
      last_truck_time: null,
      error: error.message
    };
  }
}

/**
 * Check if current time is within the email sending window
 * @param {Date} currentTime - The current timestamp
 * @param {string} firstTruckTime - ISO timestamp of first truck
 * @param {string} lastTruckTime - ISO timestamp of last truck
 * @returns {Object} { isWithinWindow: boolean, reason: string, details: Object }
 */
function isWithinTruckTimeWindow(currentTime, firstTruckTime, lastTruckTime) {
  if (!firstTruckTime || !lastTruckTime) {
    return {
      isWithinWindow: false,
      reason: 'No truck times available',
      details: { firstTruckTime, lastTruckTime }
    };
  }

  const now = currentTime instanceof Date ? currentTime : new Date(currentTime);
  const firstTruck = new Date(firstTruckTime);
  const lastTruck = new Date(lastTruckTime);

  // Validate parsed dates
  if (isNaN(firstTruck.getTime()) || isNaN(lastTruck.getTime())) {
    return {
      isWithinWindow: false,
      reason: 'Invalid truck time format',
      details: { firstTruckTime, lastTruckTime }
    };
  }

  // Check for invalid data (last before first)
  if (lastTruck < firstTruck) {
    return {
      isWithinWindow: false,
      reason: 'Invalid truck times: last truck is before first truck',
      details: { firstTruck: firstTruck.toISOString(), lastTruck: lastTruck.toISOString() }
    };
  }

  // Apply optional buffer
  const bufferMs = EMAIL_TIME_WINDOW_BUFFER_MINUTES * 60 * 1000;
  const windowStart = new Date(firstTruck.getTime() - bufferMs);
  const windowEnd = new Date(lastTruck.getTime() + bufferMs);

  if (now < windowStart) {
    return {
      isWithinWindow: false,
      reason: 'Before truck time window',
      details: {
        currentTime: now.toISOString(),
        currentTimeLocal: formatTimeInTimezone(now),
        windowStart: windowStart.toISOString(),
        firstTruck: firstTruck.toISOString(),
        bufferMinutes: EMAIL_TIME_WINDOW_BUFFER_MINUTES
      }
    };
  }

  if (now > windowEnd) {
    return {
      isWithinWindow: false,
      reason: 'After truck time window',
      details: {
        currentTime: now.toISOString(),
        currentTimeLocal: formatTimeInTimezone(now),
        windowEnd: windowEnd.toISOString(),
        lastTruck: lastTruck.toISOString(),
        bufferMinutes: EMAIL_TIME_WINDOW_BUFFER_MINUTES
      }
    };
  }

  return {
    isWithinWindow: true,
    reason: 'Within truck time window',
    details: {
      currentTime: now.toISOString(),
      currentTimeLocal: formatTimeInTimezone(now),
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString()
    }
  };
}

/**
 * Check if order data belongs to today's date
 * @param {string} orderDate - Date from order data (YYYY-MM-DD)
 * @param {string} todayDate - Today's date (YYYY-MM-DD)
 * @returns {Object} { isCurrentDay: boolean, reason: string }
 */
function isCurrentDayData(orderDate, todayDate) {
  if (!orderDate) {
    return {
      isCurrentDay: false,
      reason: 'Order date is missing'
    };
  }

  // Normalize both dates to YYYY-MM-DD format
  const normalizedOrderDate = orderDate.substring(0, 10);
  const normalizedTodayDate = todayDate.substring(0, 10);

  if (normalizedOrderDate === normalizedTodayDate) {
    return {
      isCurrentDay: true,
      reason: 'Order date matches today'
    };
  }

  return {
    isCurrentDay: false,
    reason: `Order date (${normalizedOrderDate}) does not match today (${normalizedTodayDate})`
  };
}

/**
 * Main validation function - determines if email should be sent
 * @param {Object} options
 * @param {string} options.orderDate - The date of the order data (YYYY-MM-DD)
 * @param {Date} options.currentTime - Current timestamp (optional, defaults to now)
 * @returns {Promise<Object>} { shouldSendEmail: boolean, reason: string, details: Object }
 */
async function validateEmailSendingWindow({ orderDate, currentTime }) {
  // Check if feature is enabled
  if (!EMAIL_TIME_WINDOW_ENABLED) {
    return {
      shouldSendEmail: true,
      reason: 'Email time window validation is disabled',
      details: { featureEnabled: false }
    };
  }

  const now = currentTime || new Date();
  const todayDate = getCurrentDateInTimezone(now);

  console.log(`Validating email window: orderDate=${orderDate}, today=${todayDate}, time=${formatTimeInTimezone(now)}`);

  // Step 1: Date validation - Is order data for today?
  const dateCheck = isCurrentDayData(orderDate, todayDate);

  if (!dateCheck.isCurrentDay) {
    return {
      shouldSendEmail: false,
      reason: dateCheck.reason,
      details: {
        check: 'date_mismatch',
        orderDate,
        todayDate,
        timezone: BUSINESS_TIMEZONE
      }
    };
  }

  // Step 2: Fetch truck times for today
  const truckTimes = await getDailyTruckTimes(todayDate);

  // Step 3: Handle truck-times lookup error
  if (truckTimes.error) {
    return {
      shouldSendEmail: false,
      reason: `Failed to fetch truck times: ${truckTimes.error}`,
      details: {
        check: 'truck_times_error',
        error: truckTimes.error,
        todayDate
      }
    };
  }

  // Step 4: Handle no schedules scenario
  if (!truckTimes.first_truck_time || !truckTimes.last_truck_time) {
    return {
      shouldSendEmail: false,
      reason: 'No truck schedules found for today',
      details: {
        check: 'no_schedules',
        truckTimes,
        todayDate
      }
    };
  }

  // Step 5: Time window validation
  const timeCheck = isWithinTruckTimeWindow(
    now,
    truckTimes.first_truck_time,
    truckTimes.last_truck_time
  );

  if (!timeCheck.isWithinWindow) {
    return {
      shouldSendEmail: false,
      reason: timeCheck.reason,
      details: {
        check: 'outside_time_window',
        ...timeCheck.details,
        firstTruckSource: truckTimes.first_truck_source,
        lastTruckSource: truckTimes.last_truck_source
      }
    };
  }

  // All validations passed
  return {
    shouldSendEmail: true,
    reason: 'Within valid email sending window',
    details: {
      check: 'passed',
      orderDate,
      todayDate,
      timezone: BUSINESS_TIMEZONE,
      currentTime: now.toISOString(),
      currentTimeLocal: formatTimeInTimezone(now),
      firstTruckTime: truckTimes.first_truck_time,
      lastTruckTime: truckTimes.last_truck_time,
      firstTruckSource: truckTimes.first_truck_source,
      lastTruckSource: truckTimes.last_truck_source
    }
  };
}

module.exports = {
  getDailyTruckTimes,
  isWithinTruckTimeWindow,
  isCurrentDayData,
  validateEmailSendingWindow,
  getCurrentDateInTimezone,
  formatTimeInTimezone
};
