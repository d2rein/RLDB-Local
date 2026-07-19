export function sqlString(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }

  const text = String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

export function sqlNumber(value) {
  if (value === null || value === undefined || value === "") {
    return "NULL";
  }

  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "NULL";
}

export function sqlBoolean(value) {
  return value ? "1" : "0";
}
