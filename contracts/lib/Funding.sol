// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

library Funding {
    struct Growth {
        // tw: time-weighted
        int256 twPremiumX96;
        int256 twPremiumDivBySqrtPriceX96;
    }
}
