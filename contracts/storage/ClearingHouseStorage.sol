// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { BaseRelayRecipient } from "../gsn/BaseRelayRecipient.sol";
import { Funding } from "../lib/Funding.sol";
import { IClearingHouse } from "../interface/IClearingHouse.sol";

abstract contract ClearingHouseStorageV1 is BaseRelayRecipient, IClearingHouse {
    //
    // STRUCT
    //
    struct InternalRemoveLiquidityParams {
        address maker;
        address baseToken;
        int24 lowerTick;
        int24 upperTick;
        uint128 liquidity;
    }
    struct InternalOpenPositionParams {
        address trader;
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        bool isClose;
        uint256 amount;
        uint160 sqrtPriceLimitX96; // price slippage protection
        bool skipMarginRequirementCheck;
        Funding.Growth fundingGrowthGlobal;
    }

    struct InternalClosePositionParams {
        address trader;
        address baseToken;
        uint160 sqrtPriceLimitX96;
        Funding.Growth fundingGrowthGlobal;
    }

    struct InternalCheckSlippageParams {
        bool isBaseToQuote;
        bool isExactInput;
        uint256 deltaAvailableQuote;
        uint256 deltaAvailableBase;
        uint256 oppositeAmountBound;
    }

    // --------- IMMUTABLE ---------
    address internal quoteToken;
    address internal uniswapV3Factory;

    // cache the settlement token's decimals for gas optimization
    uint8 internal _settlementTokenDecimals;
    // --------- ^^^^^^^^^ ---------

    // not used in CH, due to inherit from BaseRelayRecipient
    string public override versionRecipient;

    address internal clearingHouseConfig;
    address internal vault;
    address internal exchange;
    address internal orderBook;
    address internal accountBalance;
}
