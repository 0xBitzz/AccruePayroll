// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Calendar — UTC civil-date maths for monthly pay periods
/// @dev Day/date conversion follows Howard Hinnant's `days_from_civil` / `civil_from_days` algorithms,
///      restricted to dates on or after 1970-01-01 so everything stays unsigned.
library Calendar {
    uint256 private constant DAY = 1 days;
    uint256 private constant EPOCH_SHIFT = 719_468; // days from 0000-03-01 to 1970-01-01

    /// @notice Days since 1970-01-01 for a civil date (year >= 1970, month 1-12, day 1-31).
    function toDays(uint256 year, uint256 month, uint256 day) internal pure returns (uint256) {
        if (month <= 2) year -= 1;
        uint256 era = year / 400;
        uint256 yoe = year - era * 400;
        uint256 mp = month > 2 ? month - 3 : month + 9;
        uint256 doy = (153 * mp + 2) / 5 + day - 1;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146_097 + doe - EPOCH_SHIFT;
    }

    /// @notice Civil date for a count of days since 1970-01-01.
    function fromDays(uint256 z) internal pure returns (uint256 year, uint256 month, uint256 day) {
        z += EPOCH_SHIFT;
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        day = doy - (153 * mp + 2) / 5 + 1;
        month = mp < 10 ? mp + 3 : mp - 9;
        year = yoe + era * 400 + (month <= 2 ? 1 : 0);
    }

    /// @notice Unix timestamp of 00:00 UTC on a civil date.
    function timestamp(uint256 year, uint256 month, uint256 day) internal pure returns (uint256) {
        return toDays(year, month, day) * DAY;
    }

    /// @notice The pay period containing `t`: from the latest payday at or before `t` (00:00 UTC on `payDay` of
    ///         the month) up to, but excluding, the following payday. `payDay` must be 1-28 so every month has it.
    ///         Before the first payday after the Unix epoch, the period starts at timestamp zero.
    function period(uint8 payDay, uint256 t) internal pure returns (uint256 start, uint256 end) {
        (uint256 y, uint256 m, uint256 d) = fromDays(t / DAY);
        if (y == 1970 && m == 1 && d < payDay) return (0, timestamp(y, m, payDay));
        if (d < payDay) (y, m) = m == 1 ? (y - 1, 12) : (y, m - 1);
        start = timestamp(y, m, payDay);
        (y, m) = m == 12 ? (y + 1, 1) : (y, m + 1);
        end = timestamp(y, m, payDay);
    }

    /// @notice Number of paydays in the interval (a, b].
    function paydaysBetween(uint8 payDay, uint256 a, uint256 b) internal pure returns (uint256) {
        if (b <= a) return 0;
        (uint256 ay, uint256 am, uint256 ad) = fromDays(a / DAY);
        (uint256 by, uint256 bm, uint256 bd) = fromDays(b / DAY);
        // Count calendar months in constant time, adjusting each endpoint relative to payday.
        uint256 months = (by - ay) * 12 + bm;
        if (ad < payDay) ++months;
        if (bd < payDay) --months;
        return months - am;
    }
}
