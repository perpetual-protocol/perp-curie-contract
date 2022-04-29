// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

library Collateral {
    struct Config {
        address priceFeed;
        uint24 collateralRatio;
        uint24 discountRatio;
        uint256 depositCap;
    }
}
