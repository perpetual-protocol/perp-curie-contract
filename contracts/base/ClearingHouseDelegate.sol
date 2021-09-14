// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { SafeOwnable } from "./SafeOwnable.sol";
import { MarketRegistry } from "../MarketRegistry.sol";

abstract contract ClearingHouseDelegate is SafeOwnable {
    using AddressUpgradeable for address;

    //
    // STATE
    //
    address public marketRegistry;
    address public clearingHouse;

    // __gap is reserved storage
    uint256[50] private __gap;

    //
    // EVENT
    //
    event ClearingHouseChanged(address indexed clearingHouse);

    //
    // MODIFIER
    //
    modifier onlyClearingHouse() {
        // only ClearingHouse
        require(_msgSender() == clearingHouse, "CHD_OCH");
        _;
    }

    modifier checkCallback() {
        address pool = _msgSender();
        address baseToken = IUniswapV3Pool(pool).token0();
        require(pool == MarketRegistry(marketRegistry).getPool(baseToken), "EX_FCV");
        _;
    }

    //
    // CONSTRUCTOR
    //
    function __ClearingHouseDelegator_init(address marketRegistryArg) internal initializer {
        __SafeOwnable_init();

        // MarketRegistry is not contract
        require(marketRegistryArg.isContract(), "CHD_MRNC");
        marketRegistry = marketRegistryArg;
    }

    function setClearingHouse(address clearingHouseArg) external onlyOwner {
        // ClearingHouse is not contract
        require(clearingHouseArg.isContract(), "CHD_CHNC");
        clearingHouse = clearingHouseArg;
        emit ClearingHouseChanged(clearingHouseArg);
    }
}
