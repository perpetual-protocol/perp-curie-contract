// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { IPriceFeed } from "./interface/IPriceFeed.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { VirtualToken } from "./VirtualToken.sol";
import { BaseTokenStorageV1 } from "./storage/BaseTokenStorage.sol";
import { IBaseToken } from "./interface/IBaseToken.sol";

// never inherit any new stateful contract. never change the orders of parent stateful contracts
contract BaseToken is IBaseToken, IIndexPrice, VirtualToken, BaseTokenStorageV1 {
    using SafeMathUpgradeable for uint256;

    function initialize(
        string memory nameArg,
        string memory symbolArg,
        address priceFeedArg
    ) external initializer {
        __VirtualToken_init(nameArg, symbolArg);

        // invalid address
        require(priceFeedArg != address(0), "BT_IA");
        // invalid price feed decimals
        uint8 __priceFeedDecimals = IPriceFeed(priceFeedArg).decimals();
        require(__priceFeedDecimals <= decimals(), "BT_IPFD");

        _priceFeed = priceFeedArg;
        _priceFeedDecimals = __priceFeedDecimals;
    }

    /// @inheritdoc IIndexPrice
    function getIndexPrice(uint256 interval) external view override returns (uint256) {
        return _formatDecimals(IPriceFeed(_priceFeed).getPrice(interval));
    }

    /// @inheritdoc IBaseToken
    function getPriceFeed() external view override returns (address) {
        return _priceFeed;
    }

    function _formatDecimals(uint256 _price) internal view returns (uint256) {
        return _price.mul(10**uint256(decimals())).div(10**uint256(_priceFeedDecimals));
    }
}
