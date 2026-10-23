-- ADR 0014 "Auth", stream 3: the last TOTP time step each user signed in
-- with, so a code can't be replayed within its 90-second validity window.
ALTER TABLE `two_factors` ADD `last_totp_step` integer;
