// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { IClearingHouse } from "../interface/IClearingHouse.sol";

contract TestLimitOrderBook {
    address internal _clearingHouse;

    constructor(address clearingHouseArg) {
        _clearingHouse = clearingHouseArg;
    }

    function openPositionFor(address trader, IClearingHouse.OpenPositionParams memory params) external {
        // NOTE: here we only care about whether a contract can call `ClearingHouse.openPositionFor()` for a trader
        // for the actual `fillLimitOrder()` logic, see `perp-curie-limit-order-contract` repo
        IClearingHouse(_clearingHouse).openPositionFor(
            trader,
            IClearingHouse.OpenPositionParams({
                baseToken: params.baseToken,
                isBaseToQuote: params.isBaseToQuote,
                isExactInput: params.isExactInput,
                amount: params.amount,
                oppositeAmountBound: params.oppositeAmountBound,
                deadline: params.deadline,
                sqrtPriceLimitX96: params.sqrtPriceLimitX96,
                referralCode: params.referralCode
            })
        );
    }
}
