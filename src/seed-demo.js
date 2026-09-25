const bcrypt = require('bcryptjs');

/** Fixed demo accounts shown on login screens. Password: demo1234 */
const DEMO_USERS = [
  {
    role: 'foreman',
    full_name: 'Игорь Павлов',
    phone: '79002222222',
    specialty: null,
  },
  {
    role: 'master',
    full_name: 'Сергей Ким',
    phone: '79003333333',
    specialty: 'plumber',
  },
  {
    role: 'master',
    full_name: 'Павел Орлов',
    phone: '79004444444',
    specialty: 'electrician',
  },
  {
    role: 'master',
    full_name: 'Марина Волкова',
    phone: '79005555555',
    specialty: 'washer',
  },
  {
    role: 'inspector',
    full_name: 'Анна Соколова',
    phone: '79006666666',
    specialty: null,
  },
];

const DEMO_PASSWORD = 'demo1234';

async function seedDemoUsers(client) {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  for (const user of DEMO_USERS) {
    await client.query(
      `INSERT INTO users (role, full_name, phone, password_hash, specialty)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (phone) DO UPDATE SET
         role = EXCLUDED.role,
         full_name = EXCLUDED.full_name,
         password_hash = EXCLUDED.password_hash,
         specialty = EXCLUDED.specialty`,
      [user.role, user.full_name, user.phone, passwordHash, user.specialty]
    );
  }
}

module.exports = { seedDemoUsers, DEMO_USERS, DEMO_PASSWORD };
