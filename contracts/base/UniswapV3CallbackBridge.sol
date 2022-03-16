// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { ContextUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { IMarketRegistry } from "../interface/IMarketRegistry.sol";

abstract contract UniswapV3CallbackBridge is ContextUpgradeable {
    //
    // STATE
    //
    address internal _marketRegistry;

    // __gap is reserved storage
    uint256[50] private __gap;

    //
    // MODIFIER
    //

    modifier checkCallback() {
        address pool = _msgSender();
        address baseToken = IUniswapV3Pool(pool).token0();
        // UCB_FCV: failed callback validation
        require(pool == IMarketRegistry(_marketRegistry).getPool(baseToken), "UCB_FCV");
        _;
    }

    //
    // CONSTRUCTOR
    //
    // solhint-disable-next-line func-order
    function __UniswapV3CallbackBridge_init(address marketRegistryArg) internal initializer {
        __Context_init();

        _marketRegistry = marketRegistryArg;
    }

    function getMarketRegistry() external view returns (address) {
        return _marketRegistry;
    }
}
