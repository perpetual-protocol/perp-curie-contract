// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { IPriceFeed } from "./interface/IPriceFeed.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { VirtualToken } from "./VirtualToken.sol";

contract BaseToken is IIndexPrice, VirtualToken {
    using SafeMathUpgradeable for uint256;

    // ------ immutable states ------
    uint8 private _priceFeedDecimals;

    // ------ ^^^^^^^^^^^^^^^^ ------

    address public priceFeed;

    function initialize(
        string memory nameArg,
        string memory symbolArg,
        address priceFeedArg
    ) external initializer {
        __VirtualToken_init(nameArg, symbolArg);

        // invalid address
        require(priceFeedArg != address(0), "BT_IA");
        // invalid price feed decimals
        require(IPriceFeed(priceFeedArg).decimals() <= decimals(), "BT_IPFD");

        priceFeed = priceFeedArg;
        _priceFeedDecimals = IPriceFeed(priceFeedArg).decimals();
    }

    /// @inheritdoc IIndexPrice
    function getIndexPrice(uint256 interval) external view override returns (uint256) {
        return _formatDecimals(IPriceFeed(priceFeed).getPrice(interval));
    }

    function _formatDecimals(uint256 _price) internal view returns (uint256) {
        return _price.mul(10**uint256(decimals())).div(10**uint256(_priceFeedDecimals));
    }
}
