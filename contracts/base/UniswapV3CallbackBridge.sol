// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { SafeOwnable } from "./SafeOwnable.sol";
import { IMarketRegistry } from "../interface/IMarketRegistry.sol";

abstract contract UniswapV3CallbackBridge is SafeOwnable {
    using AddressUpgradeable for address;

    //
    // STATE
    //
    address public marketRegistry;

    //
    // MODIFIER
    //

    modifier checkCallback() {
        address pool = _msgSender();
        address baseToken = IUniswapV3Pool(pool).token0();
        // UCB_FCV: failed callback validation
        require(pool == IMarketRegistry(marketRegistry).getPool(baseToken), "UCB_FCV");
        _;
    }

    //
    // CONSTRUCTOR
    //
    function __UniswapV3CallbackBridge_init(address marketRegistryArg) internal initializer {
        __SafeOwnable_init();

        // UCB_MRNC: MarketRegistry is not contract
        require(marketRegistryArg.isContract(), "UCB_MRNC");
        marketRegistry = marketRegistryArg;
    }
}
