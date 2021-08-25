// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { IPriceFeed } from "./interface/IPriceFeed.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";

contract VirtualToken is IIndexPrice, Ownable, ERC20 {
    using SafeMath for uint256;

    event WhitelistAdded(address account);
    event WhitelistRemoved(address account);

    address public priceFeed;
    address public minter;
    uint8 private immutable _priceFeedDecimals;
    mapping(address => bool) private _whitelistMap;

    constructor(
        string memory nameArg,
        string memory symbolArg,
        address priceFeedArg
    ) ERC20(nameArg, symbolArg) {
        // invalid address
        require(priceFeedArg != address(0), "VT_IA");

        // invalid price feed decimals
        require(IPriceFeed(priceFeedArg).decimals() <= decimals(), "VT_IPFD");
        priceFeed = priceFeedArg;
        _priceFeedDecimals = IPriceFeed(priceFeedArg).decimals();

        // transfer to 0 = burn
        _whitelistMap[address(0)] = true;
    }

    /**
     * @dev Destroys `amount` tokens from the caller.
     *
     * See {ERC20-_burn}.
     */
    function burn(uint256 amount) external {
        _burn(_msgSender(), amount);
    }

    function mint(address to, uint256 amount) external {
        // only minter
        require(_msgSender() == minter, "VT_OM");
        _mint(to, amount);
    }

    function setMinter(address minterArg) external onlyOwner {
        minter = minterArg;
    }

    function addWhitelist(address account) external onlyOwner {
        _whitelistMap[account] = true;
        emit WhitelistAdded(account);
    }

    function removeWhitelist(address account) external onlyOwner {
        _whitelistMap[account] = false;
        emit WhitelistRemoved(account);
    }

    /// @inheritdoc IIndexPrice
    function getIndexPrice(uint256 interval) external view override returns (uint256) {
        return _formatDecimals(IPriceFeed(priceFeed).getPrice(interval));
    }

    function _formatDecimals(uint256 _price) internal view returns (uint256) {
        return _price.mul(10**uint256(decimals())).div(10**uint256(_priceFeedDecimals));
    }

    /// @inheritdoc ERC20
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        super._beforeTokenTransfer(from, to, amount);

        // FIXME added it back once finishing mint/burn at exchange, or add exchange to whitelist
        // not whitelisted
        //        require(_whitelistMap[from], "VT_NW");
    }
}
