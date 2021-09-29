// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { SafeOwnable } from "./SafeOwnable.sol";

abstract contract ClearingHouseCallee is SafeOwnable {
    using AddressUpgradeable for address;

    //
    // STATE
    //
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

    //
    // CONSTRUCTOR
    //
    function __ClearingHouseCallee_init() internal initializer {
        __SafeOwnable_init();
    }

    function setClearingHouse(address clearingHouseArg) external onlyOwner {
        // ClearingHouse is not contract
        require(clearingHouseArg.isContract(), "CHD_CHNC");
        clearingHouse = clearingHouseArg;
        emit ClearingHouseChanged(clearingHouseArg);
    }
}
