-- Europe/Kiev → Europe/Kyiv (правильна назва) у поясах акаунтів та ігор; пояси акаунтів за
-- містами Росії (BLOCKED_TIMEZONES у @nri/shared) → Europe/Kyiv. Пояс гри з таким поясом
-- не чіпаємо: від нього залежать дні й час розкладу.
UPDATE `users` SET `timezone` = 'Europe/Kyiv' WHERE `timezone` = 'Europe/Kiev';--> statement-breakpoint
UPDATE `games` SET `timezone` = 'Europe/Kyiv' WHERE `timezone` = 'Europe/Kiev';--> statement-breakpoint
UPDATE `users` SET `timezone` = 'Europe/Kyiv' WHERE `timezone` IN ('Europe/Moscow', 'W-SU', 'Europe/Kaliningrad', 'Europe/Kirov', 'Europe/Samara', 'Europe/Volgograd', 'Europe/Saratov', 'Europe/Ulyanovsk', 'Europe/Astrakhan', 'Asia/Yekaterinburg', 'Asia/Omsk', 'Asia/Novosibirsk', 'Asia/Barnaul', 'Asia/Tomsk', 'Asia/Novokuznetsk', 'Asia/Krasnoyarsk', 'Asia/Irkutsk', 'Asia/Chita', 'Asia/Yakutsk', 'Asia/Khandyga', 'Asia/Vladivostok', 'Asia/Ust-Nera', 'Asia/Magadan', 'Asia/Sakhalin', 'Asia/Srednekolymsk', 'Asia/Kamchatka', 'Asia/Anadyr');
