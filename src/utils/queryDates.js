// These arguments are SQL fragments owned by the caller, never raw input.
// Advance the local calendar date BEFORE converting to timestamptz (DST).
function localDateBoundary(dateSql, timeZoneSql, offsetDays = 0) {
  const date = offsetDays ? `(${dateSql} + ${offsetDays})` : dateSql;
  return `((${date})::timestamp AT TIME ZONE ${timeZoneSql})`;
}

function localDayRange(column, timeZoneSql, dateSql = `(now() AT TIME ZONE ${timeZoneSql})::date`) {
  return `${column} >= ${localDateBoundary(dateSql, timeZoneSql)} AND ${column} < ${localDateBoundary(dateSql, timeZoneSql, 1)}`;
}

module.exports = { localDateBoundary, localDayRange };
