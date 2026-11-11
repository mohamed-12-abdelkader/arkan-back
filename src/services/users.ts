import pool from '../db/pool';

export const getAllUsers = async () => {
  const res = await pool.query(
    'SELECT id, name, email, phone, role, avatar, created_at FROM users ORDER BY created_at DESC',
  );
  return res.rows;
};

export const getUserById = async (id: number | string) => {
  const res = await pool.query(
    'SELECT id, name, email, phone, role, avatar, created_at FROM users WHERE id = $1',
    [id],
  );
  return res.rows[0];
};

export const findUserByEmail = async (email: string) => {
  const res = await pool.query(
    'SELECT id, name, email, phone, role, password FROM users WHERE email = $1',
    [email],
  );
  return res.rows[0];
};

export const findUserByPhone = async (phone: string) => {
  const res = await pool.query(
    'SELECT id, name, email, phone, role, password FROM users WHERE phone = $1',
    [phone],
  );
  return res.rows[0];
};
