-- Виконується один раз при першому створенні тому mysql_data.
-- БД `nri` створюється через MYSQL_DATABASE; тут додається тестова БД
-- і надаються права користувачу MYSQL_USER на обидві.
CREATE DATABASE IF NOT EXISTS `nri` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS `nri_test` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON `nri`.* TO 'nri'@'%';
GRANT ALL PRIVILEGES ON `nri_test`.* TO 'nri'@'%';
-- Паралельні тести бекенду: окрема БД на воркер (`nri_test_1`, `nri_test_2`, …).
GRANT ALL PRIVILEGES ON `nri\_test\_%`.* TO 'nri'@'%';
FLUSH PRIVILEGES;
