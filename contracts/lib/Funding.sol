// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

library Funding {
    // overflow inspection for twPremiumX96 (as twPremiumX96 > twPremiumDivBySqrtPriceX96):
    // max = 2 ^ (255 - 96) = 2 ^ 159 = 7.307508187E47
    // assume premium = 10000, time = 10 year = 60 * 60 * 24 * 365 * 10 -> twPremium = 3.1536E12
    struct Growth {
        // tw: time-weighted
        int256 twPremiumX96;
        int256 twPremiumDivBySqrtPriceX96;
    }
}
